import {
  isPlanProvider,
  isProvider,
  isReasoning,
  PROVIDER_LABELS,
  type AiErrorCode,
  type MessageKind,
  type MessageMeta,
  type ProviderId,
  type Reasoning,
  type SummaryScope,
} from "@mc/shared";
import { APICallError, streamText, type ModelMessage } from "ai";
import { randomUUID } from "node:crypto";
import { getUserKey } from "./keys.ts";
import { languageModel, ProviderError, reasoningOptions } from "./providers.ts";
import { admin, type Admin } from "./supabase.ts";

type Row = {
  id: string;
  role: "user" | "assistant";
  author_id: string | null;
  kind: MessageKind;
  content: string;
  mentions: string[];
  reply_to: string | null;
  skip_reason: string | null;
  created_at: string;
  seq: number;
};

const HISTORY_LIMIT = 60;
const SUMMARY_LIMIT = 400;
/** Total characters of history sent to the model, newest first. Keeps one member from inflating everyone's cost. */
const HISTORY_CHAR_BUDGET = 100_000;
const MESSAGE_CHAR_LIMIT = 20_000;
const LOCK_SECONDS = 300;
const BROADCAST_EVERY_MS = 120;
const ROW_COLUMNS = "id, role, author_id, kind, content, mentions, reply_to, skip_reason, created_at, seq";

/** The run that is answering in each chat right now, so its asker can stop it. One server instance. */
const active = new Map<string, { askerId: string; controller: AbortController }>();

/** Stops the answer in progress in a chat if `userId` is the person it is answering. */
export function stopRun(chatId: string, userId: string): boolean {
  const run = active.get(chatId);
  if (!run || run.askerId !== userId) return false;
  run.controller.abort();
  return true;
}

function chatInstructions(askerName: string, modelId: string) {
  const model = /^[\w./:@+-]{1,100}$/.test(modelId) ? modelId : "an AI model";
  return `You are an AI assistant inside a shared group chat with several people. You are running as the model ${model}. If someone asks what you are, say that, and don't claim to be a different model or product.
Each user message is prefixed with the author's name in brackets, like "[Ana]: ...". Address people by name when it helps, and keep track of who said what.
Messages marked "not for you" were addressed to another person with an @tag; use them as context only and never answer them.
You are replying to the latest message(s) from ${askerName}. Other people may have messages waiting that you haven't seen yet; those are answered separately, so don't guess at them.
Don't prefix your own replies with a name.`;
}

const SUMMARY_INSTRUCTIONS = `You write short recaps of a team chat for the person who asked.
Reply in Markdown with exactly this shape and nothing before or after it:
## <a short title: the chat topic and where things stand>
**Decided**
- ...
**Still open**
- ...
**Next**
- who does what next
Keep each bullet to one line. Use people's names. Leave out a section's bullets only if there is truly nothing for it (write "- Nothing yet").`;

/** Display names are typed by users and end up in the prompt: no brackets, line breaks or control characters, so a name can't pose as another speaker. */
const promptName = (name: string) => name.replace(/[\[\]\p{C}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Someone";

const clip = (text: string) => (text.length > MESSAGE_CHAR_LIMIT ? `${text.slice(0, MESSAGE_CHAR_LIMIT)}… [truncated]` : text);

/** Newest-first within the budget, then merged so roles alternate (some providers require it). */
function toModelMessages(rows: Row[], names: Map<string, string>): ModelMessage[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kept: Row[] = [];
  let used = 0;
  for (const r of [...rows].reverse()) {
    const content = clip(r.content);
    if (used + content.length > HISTORY_CHAR_BUDGET && kept.length > 0) break;
    used += content.length;
    kept.unshift({ ...r, content });
  }
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const r of kept) {
    let text = r.content;
    if (r.role === "user") {
      const who = names.get(r.author_id ?? "") ?? "Someone";
      const tagged = r.mentions.map((id) => names.get(id)).filter(Boolean);
      const replied = r.reply_to ? byId.get(r.reply_to) : undefined;
      const parts = [who];
      if (replied) parts.push(`replying to ${replied.role === "assistant" ? "your earlier answer" : "an earlier message"} "${clip(replied.content).slice(0, 160).replace(/\s+/g, " ")}"`);
      if (r.skip_reason === "mention" && tagged.length) parts.push(`to ${tagged.map((n) => `@${n}`).join(", ")}, not for you`);
      text = `[${parts.join(", ")}]: ${r.content}`;
    }
    const last = out.at(-1);
    if (last && last.role === r.role) last.content += `\n\n${text}`;
    else if (out.length > 0 || r.role === "user") out.push({ role: r.role, content: text });
  }
  return out;
}

async function hasPending(chatId: string) {
  const { count } = await admin.from("messages").select("id", { count: "exact", head: true }).eq("chat_id", chatId).eq("status", "pending");
  return (count ?? 0) > 0;
}

/**
 * Answers the chat's pending messages, one AI run at a time. A run takes the pending messages of one author
 * (the earliest waiting) and answers them with that person's key and model; everyone else waits for the next run.
 * A summary request is a run of its own.
 */
export async function processChatQueue(chatId: string): Promise<void> {
  do {
    const { data: claimed } = await admin.rpc("claim_chat_run", { p_chat_id: chatId, p_seconds: LOCK_SECONDS });
    if (!claimed) return; // another run owns the chat and will pick up new messages
    try {
      while (await runOnce(admin, chatId)) {
        /* keep draining */
      }
    } finally {
      await admin.from("chats").update({ run_lock_until: null }).eq("id", chatId);
    }
    // Re-check after releasing the lock so a message that landed in the gap isn't stranded.
  } while (await hasPending(chatId));
}

/** After a restart: put interrupted work back in line and resume every chat that has waiting messages. */
export async function recoverRuns(): Promise<void> {
  const { data, error } = await admin.rpc("app_recover_stale_runs");
  if (error) return console.error("[run] could not recover stale runs:", error.message);
  for (const chatId of (data ?? []) as string[]) void processChatQueue(chatId).catch((e) => console.error(`[run] chat ${chatId}:`, e));
}

type Pending = {
  id: string;
  author_id: string | null;
  kind: MessageKind;
  provider: string | null;
  model: string | null;
  reasoning: string | null;
  meta: MessageMeta;
};

/** Returns false when there was nothing to do. */
async function runOnce(db: Admin, chatId: string): Promise<boolean> {
  const { data } = await db
    .from("messages")
    .select("id, author_id, kind, provider, model, reasoning, meta")
    .eq("chat_id", chatId)
    .eq("role", "user")
    .eq("status", "pending")
    .order("seq");
  const pending = (data ?? []) as Pending[];
  if (!pending.length) return false;
  const first = pending[0]!;
  const authorId = first.author_id;
  const summary = first.kind === "summary_request";
  const batch = summary ? [first] : pending.filter((m) => m.author_id === authorId && m.kind === "message");
  const batchIds = batch.map((m) => m.id);
  const choice = batch.at(-1)!; // their most recent model pick
  const provider: ProviderId | null = isProvider(choice.provider) ? choice.provider : null;
  const modelId = choice.model;
  const reasoning: Reasoning | null = isReasoning(choice.reasoning) ? choice.reasoning : null;
  const runId = randomUUID();

  await db.from("messages").update({ status: "processing", run_id: runId }).in("id", batchIds);
  const { data: assistant, error: insertErr } = await db
    .from("messages")
    .insert({
      chat_id: chatId,
      role: "assistant",
      kind: summary ? "summary" : "message",
      status: "streaming",
      content: "",
      provider,
      model: modelId,
      reasoning,
      for_user_id: authorId,
      key_user_id: authorId,
      run_id: runId,
      meta: summary ? { scope: first.meta.scope, from_seq: first.meta.from_seq } : {},
    })
    .select("id")
    .single();
  if (insertErr || !assistant) {
    await db.from("messages").update({ status: "error" }).in("id", batchIds);
    return false;
  }

  const controller = new AbortController();
  if (authorId) active.set(chatId, { askerId: authorId, controller });
  const channel = db.channel(`chat:${chatId}`, { config: { private: true } });
  const send = (content: string) => channel.httpSend("stream", { messageId: assistant.id, content });

  let apiKey: string | null = null;
  let text = "";
  try {
    const { data: members } = await db.rpc("app_chat_people", { p_chat_id: chatId });
    const names = new Map<string, string>(((members ?? []) as { id: string; display_name: string }[]).map((m) => [m.id, promptName(m.display_name)]));
    const asker = names.get(authorId ?? "") ?? "Someone";
    if (!authorId || !provider || !modelId) throw new UserFacing("no_key", "This message was sent without a model selected.");
    apiKey = await getUserKey(authorId, provider);
    if (!apiKey) throw new UserFacing("no_key", isPlanProvider(provider) ? `${asker} has not connected a ${PROVIDER_LABELS[provider]}.` : `${asker} has no ${PROVIDER_LABELS[provider]} API key saved.`);

    let instructions: string;
    let messages: ModelMessage[];
    let meta: MessageMeta = {};
    if (summary) {
      const fromSeq = Number(first.meta.from_seq ?? 0);
      const { data: rows } = await db
        .from("messages")
        .select(ROW_COLUMNS)
        .eq("chat_id", chatId)
        .in("kind", ["message", "summary"])
        .eq("status", "done")
        .gt("seq", fromSeq)
        .order("seq", { ascending: false })
        .limit(SUMMARY_LIMIT);
      const transcript = ((rows ?? []) as Row[]).reverse();
      if (!transcript.length) throw new UserFacing("other", "There was nothing new to summarize.");
      meta = { scope: first.meta.scope, from_seq: fromSeq, count: transcript.length, since: transcript[0]!.created_at };
      instructions = SUMMARY_INSTRUCTIONS;
      messages = [{ role: "user", content: `Chat transcript:\n\n${transcriptText(transcript, names)}` }];
    } else {
      const { data: history } = await db
        .from("messages")
        .select(ROW_COLUMNS)
        .eq("chat_id", chatId)
        .in("kind", ["message", "summary"])
        .in("status", ["done", "processing"])
        .order("seq", { ascending: false })
        .limit(HISTORY_LIMIT);
      instructions = chatInstructions(asker, modelId);
      messages = toModelMessages(((history ?? []) as Row[]).reverse(), names);
    }

    // streamText reports provider errors (bad key, unknown model) through onError and ends the stream quietly.
    let streamError: unknown = null;
    const result = streamText({
      onError: ({ error }) => {
        streamError = error;
      },
      model: languageModel(provider, apiKey, modelId),
      instructions,
      messages,
      ...reasoningOptions(provider, reasoning),
      abortSignal: controller.signal,
      timeout: { totalMs: (LOCK_SECONDS - 30) * 1000 },
    });

    let lastSent = 0;
    for await (const delta of result.textStream) {
      text += delta;
      if (Date.now() - lastSent >= BROADCAST_EVERY_MS) {
        lastSent = Date.now();
        void send(text); // full snapshots, not deltas: a dropped packet fixes itself with the next one
      }
    }
    if (controller.signal.aborted) throw new UserFacing("stopped", "Stopped.");
    if (streamError) throw streamError;
    if (!text.trim()) throw new UserFacing("other", "The model returned an empty reply.");
    await db.from("messages").update({ content: text, status: "done", meta }).eq("id", assistant.id);
    await db.from("messages").update({ status: "done" }).in("id", batchIds);
  } catch (err) {
    if (err instanceof UserFacing && err.code === "stopped" && text.trim()) {
      // Stopping keeps what was written so far.
      await db.from("messages").update({ content: text, status: "done" }).eq("id", assistant.id);
      await db.from("messages").update({ status: "done" }).in("id", batchIds);
    } else {
      // Everyone in the chat sees this message, so provider details stay in the server log.
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[run] chat ${chatId}: ${apiKey ? detail.split(apiKey).join("***") : detail}`);
      const failure = describeFailure(err, provider, controller.signal.aborted);
      await db.from("messages").update({ content: failure.text, status: "error", meta: { error: failure.code } }).eq("id", assistant.id);
      await db.from("messages").update({ status: "error" }).in("id", batchIds);
    }
  } finally {
    active.delete(chatId);
    await db.removeChannel(channel);
  }
  return true;
}

function transcriptText(rows: Row[], names: Map<string, string>): string {
  const lines: string[] = [];
  let used = 0;
  for (const r of [...rows].reverse()) {
    const who = r.role === "assistant" ? "AI" : (names.get(r.author_id ?? "") ?? "Someone");
    const when = new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ");
    const line = `[${when}] ${who}: ${clip(r.content)}`;
    if (used + line.length > HISTORY_CHAR_BUDGET && lines.length > 0) break;
    used += line.length;
    lines.unshift(line);
  }
  return lines.join("\n");
}

class UserFacing extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What to tell the chat, and which button it should offer. Never includes provider response bodies. */
function describeFailure(err: unknown, provider: ProviderId | null, aborted: boolean): { code: AiErrorCode; text: string } {
  const name = provider ? PROVIDER_LABELS[provider] : "The AI provider";
  if (err instanceof UserFacing) return { code: err.code, text: err.code === "no_key" ? `${err.message} They can ${provider && isPlanProvider(provider) ? "connect it" : "add one"} under Settings.` : err.message };
  if (err instanceof ProviderError) return { code: "other", text: err.message }; // written to be shown
  if (APICallError.isInstance(err) && provider && isPlanProvider(provider)) {
    // A ChatGPT plan has no credit to top up: a 429 means the plan's own usage limit.
    if (err.statusCode === 401 || err.statusCode === 403) return { code: "invalid_key", text: `${name} rejected the connection. It may have been revoked, or this account isn't allowed to use it. Reconnect it in Settings, then retry.` };
    if (err.statusCode === 429) return { code: "rate_limit", text: `The ${name} usage limit was reached. Check your usage in ChatGPT, wait for it to reset, then retry.` };
    if (err.statusCode === 404 || err.statusCode === 400) return { code: "model", text: `${name} didn't accept this model or request. Pick another model, then retry.` };
  }
  if (APICallError.isInstance(err)) {
    const body = (err.responseBody ?? "").toLowerCase();
    if (err.statusCode === 401 || err.statusCode === 403) return { code: "invalid_key", text: `${name} rejected the key. It may have been deleted or changed.` };
    if (err.statusCode === 402 || /credit|billing|quota|insufficient/.test(body)) return { code: "no_credit", text: `The ${name} account is out of credit. Add credit, then retry. Nothing that was sent is lost.` };
    if (err.statusCode === 429) return { code: "rate_limit", text: `${name} is rate limiting this key. Wait a moment, then retry.` };
    if (err.statusCode === 404 || err.statusCode === 400) return { code: "model", text: `${name} didn't accept this model or request. Pick another model, then retry.` };
  }
  if (aborted || (err instanceof Error && /abort|timeout|timed out/i.test(`${err.name} ${err.message}`))) {
    return { code: "timeout", text: "The AI took too long to answer. The connection dropped. Nothing was lost. Try again." };
  }
  return { code: "other", text: `The ${name} request failed. Check the API key and model, then retry.` };
}
