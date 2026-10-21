import { IMAGE_LIMITS, type MessageKind, type MessageMeta } from "@mc/shared";
import type { ModelMessage } from "ai";

export type Row = {
  id: string;
  role: "user" | "assistant";
  author_id: string | null;
  kind: MessageKind;
  content: string;
  mentions: string[];
  reply_to: string | null;
  skip_reason: string | null;
  meta: MessageMeta;
  created_at: string;
  seq: number;
  /** ids of the pictures attached to the message */
  images: string[];
};

/** Total characters of history sent to the model, newest first. Keeps one member from inflating everyone's cost. */
export const HISTORY_CHAR_BUDGET = 100_000;
export const MESSAGE_CHAR_LIMIT = 20_000;

/** Display names are typed by users and end up in the prompt: no brackets, line breaks or control characters, so a name can't pose as another speaker. */
export const promptName = (name: string) => name.replace(/[\[\]\p{C}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Someone";

/** A highlighted excerpt typed by a user ends up in the prompt: no quotes, brackets or line breaks, so it can't close its own quote or pose as another speaker. */
const promptQuote = (text: string) => text.replace(/[\[\]"\p{C}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 200);

export const clip = (text: string) => (text.length > MESSAGE_CHAR_LIMIT ? `${text.slice(0, MESSAGE_CHAR_LIMIT)}… [truncated]` : text);

/** The newest rows that fit the character budget, oldest first. */
export function withinBudget(rows: Row[]): Row[] {
  const kept: Row[] = [];
  let used = 0;
  for (const r of [...rows].reverse()) {
    const content = clip(r.content);
    if (used + content.length > HISTORY_CHAR_BUDGET && kept.length > 0) break;
    used += content.length;
    kept.unshift({ ...r, content });
  }
  return kept;
}

/** Ids of the newest pictures in these rows (oldest first rows, as withinBudget returns them): the only ones the AI gets to see. */
export function newestPictureIds(kept: Row[], limit: number = IMAGE_LIMITS.sentToAi): string[] {
  const ids: string[] = [];
  for (const r of [...kept].reverse()) {
    if (r.role !== "user") continue;
    for (const id of [...r.images].reverse()) if (ids.length < limit && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export type Picture = { data: Uint8Array; mediaType: string };
type Part = { type: "text"; text: string } | { type: "file"; mediaType: string; data: { type: "data"; data: Uint8Array } };

/** Newest-first within the budget, then merged so roles alternate (some providers require it). `pictures` are the files the AI may see. */
export function toModelMessages(rows: Row[], names: Map<string, string>, pictures: Map<string, Picture> = new Map()): ModelMessage[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: { role: "user" | "assistant"; parts: Part[] }[] = [];
  for (const r of withinBudget(rows)) {
    let text = r.content;
    const files: Part[] = [];
    if (r.role === "user") {
      const who = names.get(r.author_id ?? "") ?? "Someone";
      const tagged = r.mentions.map((id) => names.get(id)).filter(Boolean);
      const replied = r.reply_to ? byId.get(r.reply_to) : undefined;
      const parts = [who];
      if (replied && replied.role === "assistant" && r.meta.quote) parts.push(`replying to this part of your earlier answer: "${promptQuote(r.meta.quote)}"`);
      else if (replied) parts.push(`replying to ${replied.role === "assistant" ? "your earlier answer" : "an earlier message"} "${clip(replied.content).slice(0, 160).replace(/\s+/g, " ")}"`);
      if (r.skip_reason === "mention" && tagged.length) parts.push(`to ${tagged.map((n) => `@${n}`).join(", ")}, not for you`);
      let omitted = 0;
      for (const id of r.images) {
        const pic = pictures.get(id);
        if (pic) files.push({ type: "file", mediaType: pic.mediaType, data: { type: "data", data: pic.data } });
        else omitted++;
      }
      text = `[${parts.join(", ")}]: ${r.content}`;
      if (omitted > 0) text += ` [${omitted} ${omitted === 1 ? "picture" : "pictures"} not shown]`;
    }
    const last = out.at(-1);
    if (last && last.role === r.role) last.parts.push({ type: "text", text: `\n\n${text}` }, ...files);
    else if (out.length > 0 || r.role === "user") out.push({ role: r.role, parts: [{ type: "text", text }, ...files] });
  }
  return out.map((m) => {
    const onlyText = m.parts.every((p) => p.type === "text");
    if (m.role === "assistant" || onlyText) return { role: m.role, content: m.parts.map((p) => (p.type === "text" ? p.text : "")).join("") } as ModelMessage;
    return { role: "user", content: m.parts } as ModelMessage;
  });
}

/** One line per message, for the recap. Pictures are only counted: the recap works from words. */
export function transcriptText(rows: Row[], names: Map<string, string>): string {
  const lines: string[] = [];
  let used = 0;
  for (const r of [...rows].reverse()) {
    const who = r.role === "assistant" ? "AI" : (names.get(r.author_id ?? "") ?? "Someone");
    const when = new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ");
    const pictures = r.images.length ? ` [${r.images.length} ${r.images.length === 1 ? "picture" : "pictures"} attached]` : "";
    const line = `[${when}] ${who}: ${clip(r.content)}${pictures}`;
    if (used + line.length > HISTORY_CHAR_BUDGET && lines.length > 0) break;
    used += line.length;
    lines.unshift(line);
  }
  return lines.join("\n");
}
