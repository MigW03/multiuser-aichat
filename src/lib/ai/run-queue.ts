import { generateText, streamText, type LanguageModel } from "ai";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserKey } from "@/lib/ai/keys";
import { isProvider, languageModel, PROVIDER_LABELS } from "@/lib/ai/providers";
import { summarizeMessages } from "@/lib/ai/context/compaction";
import {
  estimateRequest,
  splitForCompaction,
  toModelMessages,
  trimToFit,
  type Checkpoint,
  type HistoryMessage,
} from "@/lib/ai/context/history";
import { textParts, type MessagePart, type StoredUsage } from "@/lib/ai/context/parts";
import { DEFAULT_CONTEXT_WINDOW, inputCeiling } from "@/lib/ai/context/tokens";

type Admin = ReturnType<typeof createAdminClient>;

// History is bounded by tokens, not count; this only stops a runaway load if summarizing keeps failing.
const HISTORY_SAFETY_LIMIT = 2000;
const LOCK_SECONDS = 300;
const BROADCAST_EVERY_MS = 120;

function instructions(askerName: string) {
  return `You are an AI assistant inside a shared group chat with several people.
Each user message is prefixed with the author's name in brackets, like "[Ana]: ...". Address people by name when it helps, and keep track of who said what.
You are replying to the latest message(s) from ${askerName}. Other people may have messages waiting that you haven't seen yet; those are answered separately, so don't guess at them.
Don't prefix your own replies with a name.`;
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
    .select("id, seq, author_id, provider, model")
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
  const batchStartSeq = Number(batch[0].seq);

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
    const [{ data: chat }, { data: members }, { data: lastCheckpoint }] = await Promise.all([
      admin.from("chats").select("context_window").eq("id", chatId).single(),
      admin.from("chat_members").select("profiles(id, display_name)").eq("chat_id", chatId),
      admin
        .from("chat_checkpoints")
        .select("id, covers_through_seq, summary")
        .eq("chat_id", chatId)
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
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
    const model = languageModel(provider, apiKey, modelId);

    let checkpoint = lastCheckpoint as Checkpoint | null;
    const { data: rows } = await admin
      .from("messages")
      .select("seq, role, author_id, content, parts, usage")
      .eq("chat_id", chatId)
      .in("status", ["done", "processing"])
      .gt("seq", checkpoint?.covers_through_seq ?? 0)
      .order("seq", { ascending: false })
      .limit(HISTORY_SAFETY_LIMIT);
    let history = ((rows ?? []) as HistoryMessage[]).map((r) => ({ ...r, seq: Number(r.seq) })).reverse();

    // Budget against the chat's window, not the model's, so every model in the chat sees the same history.
    const window = (chat?.context_window as number | null) ?? DEFAULT_CONTEXT_WINDOW;
    const ceiling = inputCeiling(window);
    const sizeOf = (messages: HistoryMessage[]) =>
      estimateRequest({ instructions: instructions(asker), checkpoint, messages, names, provider });

    if (sizeOf(history) > ceiling) {
      void send("_Summarizing earlier messages…_");
      try {
        const compacted = await compact(admin, { chatId, authorId, provider, modelId, model, checkpoint, history, names, window, batchStartSeq });
        if (compacted) ({ checkpoint, history } = compacted);
      } catch (err) {
        console.error("Chat compaction failed", chatId, err instanceof Error ? err.message.split(apiKey).join("***") : err);
      }
      if (sizeOf(history) > ceiling) history = trimToFit(history, (m) => sizeOf(m) <= ceiling, batchStartSeq);
    }

    // streamText swallows provider errors (bad key, unknown model) and just ends the stream, so capture them.
    let streamError: unknown = null;
    const result = streamText({
      onError: ({ error }) => {
        streamError = error;
      },
      model,
      instructions: instructions(asker),
      messages: toModelMessages(checkpoint, history, names),
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
    const producedBy = { provider, model: modelId };
    const [usage, reasoning] = await Promise.all([result.usage, result.reasoningText]);
    const parts: MessagePart[] = [
      ...(reasoning ? [{ type: "reasoning" as const, text: reasoning, producedBy }] : []),
      ...textParts(text, producedBy),
    ];
    const storedUsage: StoredUsage = {
      ...producedBy,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      checkpointId: checkpoint?.id ?? null,
    };
    await admin.from("messages").update({ content: text, parts, usage: storedUsage, status: "done" }).eq("id", assistant.id);
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

/**
 * Summarizes everything but the most recent messages into a new checkpoint, with the requester's model
 * and key ("each person pays for their own messages"). Returns null when nothing is old enough to fold in.
 */
async function compact(
  admin: Admin,
  opts: {
    chatId: string;
    authorId: string;
    provider: string;
    modelId: string;
    model: LanguageModel;
    checkpoint: Checkpoint | null;
    history: HistoryMessage[];
    names: Map<string, string>;
    window: number;
    batchStartSeq: number;
  },
): Promise<{ checkpoint: Checkpoint; history: HistoryMessage[] } | null> {
  const split = splitForCompaction(opts.history, opts.names, opts.window, opts.batchStartSeq);
  if (!split) return null;

  const { summary, inputTokens, outputTokens } = await summarizeMessages({
    previous: opts.checkpoint?.summary ?? null,
    messages: split.covered,
    names: opts.names,
    window: opts.window,
    summarize: async (instructions, prompt) => {
      const { text, usage } = await generateText({
        model: opts.model,
        instructions,
        prompt,
        timeout: { totalMs: 120_000 },
      });
      return { text, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    },
  });

  const { data, error } = await admin
    .from("chat_checkpoints")
    .insert({
      chat_id: opts.chatId,
      covers_through_seq: split.covered[split.covered.length - 1].seq,
      summary,
      status: "completed",
      created_by: opts.authorId,
      provider: opts.provider,
      model: opts.modelId,
      usage: { inputTokens, outputTokens },
    })
    .select("id, covers_through_seq, summary")
    .single();
  if (error || !data) throw new Error(`Could not save the summary: ${error?.message}`);
  return { checkpoint: { ...data, covers_through_seq: Number(data.covers_through_seq) }, history: split.kept };
}
