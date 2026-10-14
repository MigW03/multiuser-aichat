// Turns stored chat history into what one model sees, and decides when it must be summarized.
// Pure functions, no database or framework imports, so the logic can move to another runtime.

import type { ModelMessage } from "ai";
import { partsOf, visibleText, type StoredUsage } from "@/lib/ai/context/parts";
import { estimateTokens, inputCeiling } from "@/lib/ai/context/tokens";

export type HistoryMessage = {
  seq: number;
  role: "user" | "assistant";
  author_id: string | null;
  content: string;
  parts?: unknown;
  usage?: unknown;
};

export type Checkpoint = { id: string; covers_through_seq: number; summary: string };

/** One message as plain text, with the "[Name]: " attribution on user messages. */
export function renderMessage(m: HistoryMessage, names: Map<string, string>): string {
  const text = visibleText(partsOf(m));
  return m.role === "user" ? `[${names.get(m.author_id ?? "") ?? "Someone"}]: ${text}` : text;
}

export function renderCheckpoint(c: Checkpoint): string {
  return `<conversation-checkpoint>
Earlier messages in this chat were summarized to save space. The summary below replaces them.

${c.summary}
</conversation-checkpoint>`;
}

/** Checkpoint first, then the messages after it. Consecutive same-role messages merge; some providers require strict alternation. */
export function toModelMessages(
  checkpoint: Checkpoint | null,
  messages: HistoryMessage[],
  names: Map<string, string>,
): ModelMessage[] {
  const out: ModelMessage[] = [];
  const push = (role: "user" | "assistant", text: string) => {
    const last = out[out.length - 1];
    if (last && last.role === role && typeof last.content === "string") last.content += `\n\n${text}`;
    else out.push({ role, content: text });
  };
  if (checkpoint) push("user", renderCheckpoint(checkpoint));
  for (const m of messages) push(m.role, renderMessage(m, names));
  return out;
}

/**
 * Size of a request built from this history. The provider's own count for the latest reply is the anchor
 * when it comes from the same provider and the same checkpoint; everything after it, or everything when
 * there is no anchor, is estimated.
 */
export function estimateRequest(opts: {
  instructions: string;
  checkpoint: Checkpoint | null;
  messages: HistoryMessage[];
  names: Map<string, string>;
  provider: string;
}): number {
  const { messages, checkpoint, names } = opts;
  let anchorIndex = -1;
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i].usage as StoredUsage | null | undefined;
    if (
      messages[i].role === "assistant" &&
      u?.provider === opts.provider &&
      u.checkpointId === (checkpoint?.id ?? null) &&
      typeof u.inputTokens === "number"
    ) {
      anchorIndex = i;
      total = u.inputTokens + (u.outputTokens ?? estimateTokens(renderMessage(messages[i], names)));
      break;
    }
  }
  if (anchorIndex < 0) {
    total = estimateTokens(opts.instructions) + (checkpoint ? estimateTokens(renderCheckpoint(checkpoint)) : 0);
  }
  for (let i = anchorIndex + 1; i < messages.length; i++) total += estimateTokens(renderMessage(messages[i], names));
  return total;
}

/** Share of the budget kept verbatim after a compaction, so the latest exchanges keep their full detail. */
const KEEP_RECENT_SHARE = 0.25;

/**
 * Splits history into what gets summarized and what stays verbatim. Messages from protectFromSeq on
 * (the batch being answered) always stay. Returns null when there is nothing old enough to summarize.
 */
export function splitForCompaction(
  messages: HistoryMessage[],
  names: Map<string, string>,
  window: number,
  protectFromSeq: number,
): { covered: HistoryMessage[]; kept: HistoryMessage[] } | null {
  const keepBudget = inputCeiling(window) * KEEP_RECENT_SHARE;
  let kept = 0;
  let start = messages.length;
  while (start > 0) {
    const m = messages[start - 1];
    const size = estimateTokens(renderMessage(m, names));
    if (m.seq < protectFromSeq && kept + size > keepBudget) break;
    kept += size;
    start--;
  }
  // Start the kept part on a user message so the model never sees a reply without its question.
  while (start < messages.length && messages[start].role === "assistant" && messages[start].seq < protectFromSeq) start++;
  if (start === 0) return null;
  return { covered: messages.slice(0, start), kept: messages.slice(start) };
}

/** Last resort when summarizing fails: drop the oldest unprotected messages until the request fits. */
export function trimToFit(
  messages: HistoryMessage[],
  fits: (messages: HistoryMessage[]) => boolean,
  protectFromSeq: number,
): HistoryMessage[] {
  let start = 0;
  while (start < messages.length && messages[start].seq < protectFromSeq && !fits(messages.slice(start))) start++;
  while (start < messages.length && messages[start].role === "assistant" && messages[start].seq < protectFromSeq) start++;
  return messages.slice(start);
}
