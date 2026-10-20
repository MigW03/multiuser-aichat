import {
  isPlanProvider,
  isProvider,
  isReasoning,
  PROVIDER_LABELS,
  type AiErrorCode,
  type ApprovalDoneEvent,
  type ApprovalEvent,
  type ChangePreview,
  type MessageKind,
  type McpState,
  type MessageMeta,
  type ProviderId,
  type Reasoning,
  type SummaryScope,
} from "@mc/shared";
import { APICallError, stepCountIs, streamText, type ModelMessage, type ToolSet } from "ai";
import { randomUUID } from "node:crypto";
import { FOLDER_MAX_STEPS, FOLDER_MAX_STEPS_EDIT, fitFiles, folderInstructions, folderTools, type FolderUse } from "./folder-tools.ts";
import { mcpInstructions, mcpTools } from "./mcp-tools.ts";
import { noteInstructions, noteTools } from "./notes-tools.ts";
import { mcpRelay } from "./mcp.ts";
import { remoteMcp } from "./mcp-servers.ts";
import { folderAccess, hub } from "./folders.ts";
import type { CallOptions, RelayRequest } from "./folder-relay.ts";
import type { McpCallOptions, McpRequest } from "./mcp-relay.ts";
import { chatgptProviderOptions } from "./chatgpt.ts";
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
  meta: MessageMeta;
  created_at: string;
  seq: number;
};

const HISTORY_LIMIT = 60;
const SUMMARY_LIMIT = 400;
/** Total characters of history sent to the model, newest first. Keeps one member from inflating everyone's cost. */
const HISTORY_CHAR_BUDGET = 100_000;
const MESSAGE_CHAR_LIMIT = 20_000;
const LOCK_SECONDS = 300;
/** A run that may propose file changes can wait for the host's decision (up to 5 minutes each), so its lock is longer. */
const LOCK_SECONDS_EDIT = 20 * 60;
const BROADCAST_EVERY_MS = 120;
const ROW_COLUMNS = "id, role, author_id, kind, content, mentions, reply_to, skip_reason, meta, created_at, seq";

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

const SUMMARY_INSTRUCTIONS = `You write a short recap of a team chat for the person who asked.
Reply in Markdown. Start with one sentence on what the chat was about and where it ended.
Then add only the lists that apply, as short one-line bullets with people's names:
- Decisions made
- Open questions
- Next steps, with who owns them
Skip any list that has nothing real in it. Never write "nothing yet" or other filler.
If the chat was only discussion, a few sentences are enough.
Don't invent decisions, owners or tasks.`;

/** Display names are typed by users and end up in the prompt: no brackets, line breaks or control characters, so a name can't pose as another speaker. */
const promptName = (name: string) => name.replace(/[\[\]\p{C}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Someone";

/** A highlighted excerpt typed by a user ends up in the prompt: no quotes, brackets or line breaks, so it can't close its own quote or pose as another speaker. */
const promptQuote = (text: string) => text.replace(/[\[\]"\p{C}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 200);

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
      if (replied && replied.role === "assistant" && r.meta.quote) parts.push(`replying to this part of your earlier answer: "${promptQuote(r.meta.quote)}"`);
      else if (replied) parts.push(`replying to ${replied.role === "assistant" ? "your earlier answer" : "an earlier message"} "${clip(replied.content).slice(0, 160).replace(/\s+/g, " ")}"`);
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
    let folder: { tools: ToolSet; use: FolderUse; caps: { edit: boolean; git: boolean; exec: boolean } } | null = null;
    /** The asker's own connected tools (MCP), if their desktop app is online and has any switched on. */
    let connected: { tools: ToolSet; state: McpState } | null = null;
    /** "server: tool" for each connected tool this answer used, for the note under it. */
    const mcpUsed = new Set<string>();
    /** The AI can add a note in a project chat; notes are the asker's own, and shared with the project. */
    let noting: ToolSet | null = null;
    let runSeconds = LOCK_SECONDS;
    let folderName = "";
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

      // A project chat can read the project's shared folder, if one is shared. The check is the asker's own membership.
      const { data: chatRow } = await db.from("chats").select("project_id").eq("id", chatId).maybeSingle();
      const projectId = (chatRow?.project_id as string | null | undefined) ?? null;
      if (projectId) {
        noting = noteTools(async (title, body) => {
          const { error } = await db.rpc("app_note_create", { p_user: authorId, p_project: projectId, p_title: title, p_body: body, p_ai: true });
          if (error) console.error(`[run] chat ${chatId}: take_note failed:`, error.message);
          return error ? { ok: false, code: error.message.trim() } : { ok: true };
        });
      }
      const access = projectId ? await folderAccess(authorId, projectId) : null;
      if (projectId && access?.ok) {
        folderName = access.name;
        const use: FolderUse = { files: new Set(), offline: false, edits: [], mcp: mcpUsed };
        // AI changes and git are on only when the host switched them on in their app. Every change still needs the host's approval there.
        const caps = await hub.caps(projectId);
        const canChange = caps.edit || caps.git || caps.exec;
        const changes = canChange
          ? {
              askedBy: asker,
              signal: controller.signal,
              preview: (change: ChangePreview) => void channel.httpSend("approval", { messageId: assistant.id, change, askedBy: asker, readFiles: use.files.size } satisfies ApprovalEvent),
              done: (id: string, outcome: ApprovalDoneEvent["outcome"]) => void channel.httpSend("approval_done", { messageId: assistant.id, id, outcome } satisfies ApprovalDoneEvent),
            }
          : undefined;
        const call = (req: RelayRequest, opts?: CallOptions) => hub.call(projectId, req as never, opts);
        folder = { tools: folderTools(call, use, changes, caps), use, caps };
        if (canChange) {
          runSeconds = LOCK_SECONDS_EDIT;
          await db.from("chats").update({ run_lock_until: new Date(Date.now() + runSeconds * 1000).toISOString() }).eq("id", chatId);
        }
      }

      // The asker's own connected tools (MCP), in any chat: nobody else's tools are ever offered for this answer. Local servers
      // run on their computer (their desktop app answers); remote ones are called from here. A built-in tool keeps its name.
      const localState = mcpRelay.tools(authorId);
      const remoteState = await remoteMcp.state(authorId).catch((e) => {
        console.error("[run] remote MCP tools unavailable:", e instanceof Error ? e.message : e);
        return { servers: [] } as McpState;
      });
      if (localState.servers.length || remoteState.servers.length) {
        const reserved = [...Object.keys(folder?.tools ?? {}), ...Object.keys(noting ?? {})];
        const localTools = localState.servers.length ? mcpTools((req: McpRequest, opts?: McpCallOptions) => mcpRelay.call(authorId, req, opts), localState, { reserved, signal: controller.signal, used: mcpUsed }) : {};
        const remoteTools = remoteState.servers.length ? mcpTools((req: McpRequest, opts?: McpCallOptions) => remoteMcp.call(authorId, req, opts), remoteState, { reserved: [...reserved, ...Object.keys(localTools)], signal: controller.signal, used: mcpUsed }) : {};
        connected = { tools: { ...localTools, ...remoteTools }, state: { servers: [...localState.servers, ...remoteState.servers] } };
        if (runSeconds < LOCK_SECONDS_EDIT) {
          runSeconds = LOCK_SECONDS_EDIT;
          await db.from("chats").update({ run_lock_until: new Date(Date.now() + runSeconds * 1000).toISOString() }).eq("id", chatId);
        }
      }
    }

    const model = languageModel(provider, apiKey, modelId);
    // A ChatGPT plan call keeps nothing on OpenAI's side between calls; see chatgptProviderOptions.
    const planOptions = provider === "chatgpt" ? chatgptProviderOptions : null;
    const thinking = reasoningOptions(provider, reasoning);
    const providerOptions = { ...("providerOptions" in thinking ? thinking.providerOptions : {}), ...(planOptions ?? {}) };

    /** One attempt at the answer. Returns the provider error, if any, instead of throwing it. */
    const attempt = async (withTools: boolean): Promise<unknown> => {
      // streamText reports provider errors (bad key, unknown model) through onError and ends the stream quietly.
      let streamError: unknown = null;
      const result = streamText({
        onError: ({ error }) => {
          streamError = error;
        },
        model,
        instructions: `${instructions}${folder ? `\n\n${folderInstructions(folderName, withTools, folder.caps.edit, folder.caps.git, folder.caps.exec)}` : ""}${withTools && connected ? `\n\n${mcpInstructions(connected.state, asker)}` : ""}${withTools && noting ? `\n\n${noteInstructions}` : ""}`,
        messages,
        ...thinking,
        ...(Object.keys(providerOptions).length ? { providerOptions } : {}),
        ...(withTools && (folder || connected || noting) ? { tools: { ...connected?.tools, ...folder?.tools, ...noting }, stopWhen: stepCountIs(folder?.caps.edit || folder?.caps.git || folder?.caps.exec || connected ? FOLDER_MAX_STEPS_EDIT : FOLDER_MAX_STEPS) } : {}),
        abortSignal: controller.signal,
        timeout: { totalMs: (runSeconds - 30) * 1000 },
      });

      let lastSent = 0;
      let breakBefore = false; // text written before and after a tool call reads as separate paragraphs
      for await (const part of result.fullStream) {
        if (part.type === "tool-call") breakBefore = text.length > 0;
        if (part.type !== "text-delta") continue;
        text += (breakBefore ? "\n\n" : "") + part.text;
        breakBefore = false;
        if (Date.now() - lastSent >= BROADCAST_EVERY_MS) {
          lastSent = Date.now();
          void send(text); // full snapshots, not deltas: a dropped packet fixes itself with the next one
        }
      }
      return streamError;
    };

    let streamError = await attempt(true);
    // Some connections refuse tools (a model without tool support, or a ChatGPT plan backend that changed). Rather than
    // fail the answer, answer once more without the folder, and say why.
    if (streamError && (folder || connected || noting) && !text && !controller.signal.aborted && APICallError.isInstance(streamError) && [400, 404, 422].includes(streamError.statusCode ?? 0)) {
      console.error(`[run] chat ${chatId}: tools refused, answering without the shared folder and connected tools (${streamError.statusCode})`);
      streamError = await attempt(false);
      if (!streamError) {
        folder?.use.files.clear();
        mcpUsed.clear();
      }
    }
    if (controller.signal.aborted) throw new UserFacing("stopped", "Stopped.");
    if (streamError) throw streamError;
    if (!text.trim()) throw new UserFacing("other", "The model returned an empty reply.");
    if (folder || mcpUsed.size) meta = { ...meta, ...fitFiles(folder?.use ?? { files: new Set(), offline: false, edits: [], mcp: mcpUsed }) };
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
