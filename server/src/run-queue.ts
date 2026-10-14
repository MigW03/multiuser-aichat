import { isProvider, PROVIDER_LABELS, type ProviderId } from "@mc/shared";
import { streamText, type ModelMessage } from "ai";
import { getUserKey } from "./keys.ts";
import { languageModel } from "./providers.ts";
import { admin, type Admin } from "./supabase.ts";

type Row = { id: string; role: "user" | "assistant"; author_id: string | null; content: string };

const HISTORY_LIMIT = 60;
/** Total characters of history sent to the model, newest first. Keeps one member from inflating everyone's cost. */
const HISTORY_CHAR_BUDGET = 100_000;
const MESSAGE_CHAR_LIMIT = 20_000;
const LOCK_SECONDS = 300;
const BROADCAST_EVERY_MS = 120;

function instructions(askerName: string) {
  return `You are an AI assistant inside a shared group chat with several people.
Each user message is prefixed with the author's name in brackets, like "[Ana]: ...". Address people by name when it helps, and keep track of who said what.
You are replying to the latest message(s) from ${askerName}. Other people may have messages waiting that you haven't seen yet; those are answered separately, so don't guess at them.
Don't prefix your own replies with a name.`;
}

/** Newest-first within the budget, then merged so roles alternate (some providers require it). */
function toModelMessages(rows: Row[], names: Map<string, string>): ModelMessage[] {
  const kept: Row[] = [];
  let used = 0;
  for (const r of [...rows].reverse()) {
    const content = r.content.length > MESSAGE_CHAR_LIMIT ? `${r.content.slice(0, MESSAGE_CHAR_LIMIT)}… [truncated]` : r.content;
    if (used + content.length > HISTORY_CHAR_BUDGET && kept.length > 0) break;
    used += content.length;
    kept.unshift({ ...r, content });
  }
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const r of kept) {
    const text = r.role === "user" ? `[${names.get(r.author_id ?? "") ?? "Someone"}]: ${r.content}` : r.content;
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

/** Returns false when there was nothing to do. */
async function runOnce(db: Admin, chatId: string): Promise<boolean> {
  const { data: pending } = await db.from("messages").select("id, author_id, provider, model").eq("chat_id", chatId).eq("status", "pending").order("seq");
  if (!pending?.length) return false;
  const authorId = pending[0]!.author_id as string | null;
  const batch = pending.filter((m) => m.author_id === authorId);
  const batchIds = batch.map((m) => m.id as string);
  const choice = batch.at(-1)!; // their most recent model pick
  const provider: ProviderId | null = isProvider(choice.provider) ? choice.provider : null;
  const modelId = choice.model as string | null;

  await db.from("messages").update({ status: "processing" }).in("id", batchIds);
  const { data: assistant, error: insertErr } = await db
    .from("messages")
    .insert({ chat_id: chatId, role: "assistant", status: "streaming", content: "", provider, model: modelId })
    .select("id")
    .single();
  if (insertErr || !assistant) {
    await db.from("messages").update({ status: "error" }).in("id", batchIds);
    return false;
  }

  const channel = db.channel(`chat:${chatId}`, { config: { private: true } });
  const send = (content: string) => channel.httpSend("stream", { messageId: assistant.id, content });

  let apiKey: string | null = null;
  try {
    const [{ data: history }, { data: members }] = await Promise.all([
      db.from("messages").select("id, role, author_id, content").eq("chat_id", chatId).in("status", ["done", "processing"]).order("seq", { ascending: false }).limit(HISTORY_LIMIT),
      db.from("chat_members").select("profiles(id, display_name)").eq("chat_id", chatId),
    ]);
    const names = new Map<string, string>();
    for (const m of members ?? []) {
      const p = m.profiles as unknown as { id: string; display_name: string } | null;
      if (p) names.set(p.id, p.display_name);
    }

    const asker = names.get(authorId ?? "") ?? "Someone";
    if (!authorId || !provider || !modelId) throw new UserFacing("This message was sent without a model selected.");
    apiKey = await getUserKey(authorId, provider);
    if (!apiKey) throw new UserFacing(`${asker} has no ${PROVIDER_LABELS[provider]} API key saved. They can add one under API keys.`);

    // streamText reports provider errors (bad key, unknown model) through onError and ends the stream quietly.
    let streamError: unknown = null;
    const result = streamText({
      onError: ({ error }) => {
        streamError = error;
      },
      model: languageModel(provider, apiKey, modelId),
      instructions: instructions(asker),
      messages: toModelMessages(((history ?? []) as Row[]).reverse(), names),
      timeout: { totalMs: (LOCK_SECONDS - 30) * 1000 },
    });

    let text = "";
    let lastSent = 0;
    for await (const delta of result.textStream) {
      text += delta;
      if (Date.now() - lastSent >= BROADCAST_EVERY_MS) {
        lastSent = Date.now();
        void send(text); // full snapshots, not deltas: a dropped packet fixes itself with the next one
      }
    }
    if (streamError) throw streamError;
    if (!text.trim()) throw new UserFacing("The model returned an empty reply.");
    await db.from("messages").update({ content: text, status: "done" }).eq("id", assistant.id);
    await db.from("messages").update({ status: "done" }).in("id", batchIds);
  } catch (err) {
    // Everyone in the chat sees this message, so provider details stay in the server log.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[run] chat ${chatId}: ${apiKey ? detail.split(apiKey).join("***") : detail}`);
    const shown = err instanceof UserFacing ? err.message : `The ${provider ? PROVIDER_LABELS[provider] : "AI"} request failed. Check the API key and model.`;
    await db.from("messages").update({ content: `Sorry, something went wrong: ${shown}`, status: "error" }).eq("id", assistant.id);
    await db.from("messages").update({ status: "error" }).in("id", batchIds);
  } finally {
    await db.removeChannel(channel);
  }
  return true;
}

class UserFacing extends Error {}
