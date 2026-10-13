import { streamText, type ModelMessage } from "ai";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserKey } from "@/lib/ai/keys";
import { isProvider, languageModel, PROVIDER_LABELS } from "@/lib/ai/providers";

type Admin = ReturnType<typeof createAdminClient>;

type Row = {
  id: string;
  role: "user" | "assistant";
  author_id: string | null;
  content: string;
  status: string;
};

const HISTORY_LIMIT = 60;
const LOCK_SECONDS = 300;
const BROADCAST_EVERY_MS = 120;

function instructions(askerName: string) {
  return `You are an AI assistant inside a shared group chat with several people.
Each user message is prefixed with the author's name in brackets, like "[Ana]: ...". Address people by name when it helps, and keep track of who said what.
You are replying to the latest message(s) from ${askerName}. Other people may have messages waiting that you haven't seen yet; those are answered separately, so don't guess at them.
Don't prefix your own replies with a name.`;
}

/** Merge consecutive same-role messages; some providers require strict alternation. */
function toModelMessages(rows: Row[], names: Map<string, string>): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const r of rows) {
    const text = r.role === "user" ? `[${names.get(r.author_id ?? "") ?? "Someone"}]: ${r.content}` : r.content;
    const last = out[out.length - 1];
    if (last && last.role === r.role && typeof last.content === "string") {
      last.content += `\n\n${text}`;
    } else {
      out.push({ role: r.role, content: text });
    }
  }
  return out;
}

async function hasPending(admin: Admin, chatId: string) {
  const { count } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("chat_id", chatId)
    .eq("status", "pending");
  return (count ?? 0) > 0;
}

/**
 * Drains the chat's pending messages, one AI run at a time.
 * Each person's messages are answered with their own API key and chosen model, so a run
 * takes the pending messages of one author (the earliest waiting). Everyone else's wait
 * for the next run, and messages that arrive mid-run wait too.
 */
export async function processChatQueue(chatId: string) {
  const admin = createAdminClient();

  // Re-check after releasing the lock so a message that landed in the gap isn't stranded.
  do {
    const { data: claimed } = await admin.rpc("claim_chat_run", { p_chat_id: chatId, p_seconds: LOCK_SECONDS });
    if (!claimed) return; // another run owns the chat and will pick up our message

    try {
      while (await runOnce(admin, chatId)) {
        /* keep draining */
      }
    } finally {
      await admin.from("chats").update({ run_lock_until: null }).eq("id", chatId);
    }
  } while (await hasPending(admin, chatId));
}

/** Returns false when there was nothing to do. */
async function runOnce(admin: Admin, chatId: string): Promise<boolean> {
  const { data: pending } = await admin
    .from("messages")
    .select("id, author_id, provider, model")
    .eq("chat_id", chatId)
    .eq("status", "pending")
    .order("seq");
  if (!pending?.length) return false;
  const authorId = pending[0].author_id as string | null;
  const batch = pending.filter((m) => m.author_id === authorId);
  const batchIds = batch.map((m) => m.id);
  const choice = batch[batch.length - 1]; // their most recent model pick
  const provider = isProvider(choice.provider) ? choice.provider : null;
  const modelId = choice.model as string | null;

  await admin.from("messages").update({ status: "processing" }).in("id", batchIds);

  const { data: assistant, error: insertErr } = await admin
    .from("messages")
    .insert({ chat_id: chatId, role: "assistant", status: "streaming", content: "", provider, model: modelId })
    .select("id")
    .single();
  if (insertErr || !assistant) {
    await admin.from("messages").update({ status: "error" }).in("id", batchIds);
    return false;
  }

  const channel = admin.channel(`chat:${chatId}`, { config: { private: true } });
  const send = (content: string) => channel.httpSend("stream", { messageId: assistant.id, content });

  let apiKey: string | null = null;
  try {
    const [{ data: history }, { data: members }] = await Promise.all([
      admin
        .from("messages")
        .select("id, role, author_id, content, status")
        .eq("chat_id", chatId)
        .in("status", ["done", "processing"])
        .order("seq", { ascending: false })
        .limit(HISTORY_LIMIT),
      admin.from("chat_members").select("profiles(id, display_name)").eq("chat_id", chatId),
    ]);

    const names = new Map<string, string>();
    for (const m of members ?? []) {
      const p = m.profiles as unknown as { id: string; display_name: string } | null;
      if (p) names.set(p.id, p.display_name);
    }

    const asker = names.get(authorId ?? "") ?? "Someone";
    if (!authorId || !provider || !modelId) throw new Error("This message was sent without a model selected.");
    apiKey = await getUserKey(authorId, provider);
    if (!apiKey) throw new Error(`${asker} has no ${PROVIDER_LABELS[provider]} API key saved. They can add one in Settings.`);

    // streamText swallows provider errors (bad key, unknown model) and just ends the stream, so capture them.
    let streamError: unknown = null;
    const result = streamText({
      onError: ({ error }) => {
        streamError = error;
      },
      model: languageModel(provider, apiKey, modelId),
      instructions: instructions(asker),
      messages: toModelMessages((history ?? []).reverse() as Row[], names),
      timeout: { totalMs: (LOCK_SECONDS - 30) * 1000 },
    });

    let text = "";
    let lastSent = 0;
    for await (const delta of result.textStream) {
      text += delta;
      if (Date.now() - lastSent >= BROADCAST_EVERY_MS) {
        lastSent = Date.now();
        void send(text); // snapshots, not deltas: a dropped packet self-heals on the next one
      }
    }

    if (streamError) throw streamError;
    await admin.from("messages").update({ content: text, status: "done" }).eq("id", assistant.id);
    await admin.from("messages").update({ status: "done" }).in("id", batchIds);
  } catch (err) {
    let message = err instanceof Error ? err.message : "AI request failed";
    if (apiKey) message = message.split(apiKey).join("***"); // provider errors can echo the key back
    await admin
      .from("messages")
      .update({ content: `Sorry, something went wrong: ${message}`, status: "error" })
      .eq("id", assistant.id);
    await admin.from("messages").update({ status: "error" }).in("id", batchIds);
  } finally {
    await admin.removeChannel(channel);
  }
  return true;
}
