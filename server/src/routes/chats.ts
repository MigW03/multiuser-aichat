import { DEFAULT_CHAT_TITLE, IMAGE_LIMITS, IMAGE_ONLY_TEXT, isExcerptOf, isPlanProvider, LIMITS, parseDesignMarker, PROVIDER_IDS, PROVIDER_LABELS, REASONING_LEVELS, type MessageMeta, type ImageUrlsResponse, type SendMessageResponse, type SkipReason } from "@mc/shared";
import { Hono } from "hono";
import { z } from "zod";
import { rateLimit, type AuthVars } from "../auth.ts";
import { nameChat } from "../chat-title.ts";
import { dbError } from "../errors.ts";
import { claimImages, imagePathsOfChats, releaseImages, removeImageFiles, signedUrls, storeImage } from "../images.ts";
import { listKeyHints } from "../keys.ts";
import { processChatQueue, stopRun } from "../run-queue.ts";
import { admin } from "../supabase.ts";
import { createInviteFor, listInvitesFor } from "./invites.ts";

export const chats = new Hono<AuthVars>();
export const messages = new Hono<AuthVars>();

const uuid = z.uuid();
const NOT_FOUND = "That doesn't exist, or you don't have access to it.";

const createBody = z.object({ projectId: z.uuid().nullish(), title: z.string().trim().max(LIMITS.titleChars).optional() });
const titleBody = z.object({ title: z.string().trim().min(1).max(LIMITS.titleChars) });
const inviteBody = z.object({ email: z.string().trim().min(3).max(254) });
const modelBody = {
  provider: z.enum(PROVIDER_IDS),
  model: z.string().regex(LIMITS.modelIdPattern),
  reasoning: z.enum(REASONING_LEVELS).optional(),
};
const sendBody = z
  .object({
    id: z.uuid(), // chosen by the client so its optimistic copy matches the saved row
    content: z.string().trim().max(LIMITS.messageChars),
    provider: modelBody.provider.optional(),
    model: modelBody.model.optional(),
    reasoning: modelBody.reasoning,
    mentions: z.array(z.uuid()).max(10).optional(),
    replyTo: z.uuid().optional(),
    quote: z.string().trim().min(1).max(LIMITS.quoteChars).optional(),
    images: z.array(z.uuid()).max(IMAGE_LIMITS.perMessage).optional(),
  })
  .refine((b) => b.content.length > 0 || (b.images?.length ?? 0) > 0);
const imageUrlsBody = z.object({ ids: z.array(z.uuid()).min(1).max(100) });
// For "unread" the client passes the read marker it had when the chat was opened (the live marker moves as it reads).
const summarizeBody = z.object({ id: z.uuid(), scope: z.enum(["unread", "day", "all"]), fromSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1).optional(), ...modelBody });

async function canAccess(userId: string, chatId: string): Promise<boolean> {
  const { data } = await admin.rpc("user_can_access_chat", { p_user: userId, p_chat: chatId });
  return data === true;
}

/** Ids of the people currently in the chat (project members, or the chat's own members). */
async function currentMemberIds(chat: { id: string; project_id: string | null }): Promise<Set<string>> {
  const { data } = chat.project_id
    ? await admin.from("project_members").select("user_id").eq("project_id", chat.project_id)
    : await admin.from("chat_members").select("user_id").eq("chat_id", chat.id);
  return new Set((data ?? []).map((r) => r.user_id as string));
}

chats.post("/", rateLimit("chat-create", 60, 60_000), async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
  const { data, error } = await admin.rpc("app_create_chat", {
    p_user: c.get("userId"),
    p_project: parsed.data.projectId ?? null,
    p_title: parsed.data.title ?? DEFAULT_CHAT_TITLE,
  });
  return error ? dbError(c, error) : c.json({ id: data as string });
});

chats.patch("/:id", async (c) => {
  const parsed = titleBody.safeParse(await c.req.json().catch(() => null));
  if (!uuid.safeParse(c.req.param("id")).success || !parsed.success) return c.json({ error: "Give the chat a title (80 characters at most)." }, 400);
  const { data, error } = await admin.rpc("app_rename_chat", { p_user: c.get("userId"), p_chat: c.req.param("id"), p_title: parsed.data.title });
  return error ? dbError(c, error) : c.json({ title: data as string });
});

chats.delete("/:id", async (c) => {
  if (!uuid.safeParse(c.req.param("id")).success) return c.json({ error: "Invalid request" }, 400);
  // The pictures' files are removed from storage once the database accepts the delete (it checks who may delete).
  const paths = await imagePathsOfChats([c.req.param("id")]);
  const { error } = await admin.rpc("app_delete_chat", { p_user: c.get("userId"), p_chat: c.req.param("id") });
  if (error) return dbError(c, error);
  void removeImageFiles(paths);
  return c.json({ ok: true });
});

chats.post("/:id/invites", rateLimit("invite", 20, 60 * 60_000), async (c) => {
  const parsed = inviteBody.safeParse(await c.req.json().catch(() => null));
  if (!uuid.safeParse(c.req.param("id")).success || !parsed.success) return c.json({ error: "Enter an email address." }, 400);
  return createInviteFor(c, { project: null, chat: c.req.param("id"), email: parsed.data.email, role: "member" });
});

chats.get("/:id/invites", async (c) => {
  if (!uuid.safeParse(c.req.param("id")).success) return c.json({ error: "Invalid request" }, 400);
  return listInvitesFor(c, { project: null, chat: c.req.param("id") });
});

chats.post("/:id/messages", rateLimit("send", 30, 60_000), async (c) => {
  const chatId = c.req.param("id");
  const parsed = sendBody.safeParse(await c.req.json().catch(() => null));
  if (!uuid.safeParse(chatId).success || !parsed.success) return c.json({ error: "Invalid message" }, 400);
  const userId = c.get("userId");
  const { id, provider, model, reasoning, replyTo, quote } = parsed.data;
  const imageIds = [...new Set(parsed.data.images ?? [])];
  // A message with pictures and no words is saved with a short placeholder so lists and the AI have something to show.
  const content = parsed.data.content || IMAGE_ONLY_TEXT;

  if (!(await canAccess(userId, chatId))) return c.json({ error: NOT_FOUND }, 404);
  const { data: chat } = await admin.from("chats").select("id, title, project_id").eq("id", chatId).single();
  if (!chat) return c.json({ error: NOT_FOUND }, 404);

  // People tagged with @ must be in this chat; a tag means the message is for them, not for the AI.
  const members = await currentMemberIds(chat);
  const mentions = [...new Set(parsed.data.mentions ?? [])].filter((m) => m !== userId);
  if (mentions.some((m) => !members.has(m))) return c.json({ error: "You can only tag people who are in this chat." }, 400);

  // An excerpt is kept only when it really comes from the answer being replied to, so it can't put words in the AI's mouth.
  let meta: MessageMeta = {};
  if (replyTo) {
    const { data: target } = await admin.from("messages").select("id, role, content").eq("id", replyTo).eq("chat_id", chatId).maybeSingle();
    if (!target) return c.json({ error: "The message you are replying to is gone." }, 400);
    // the meta column holds under 1 KB; 700 bytes of quote leaves room for the JSON around it
    if (quote && Buffer.byteLength(quote) <= 700 && target.role === "assistant" && isExcerptOf(quote, target.content)) meta = { quote };
  }

  // The AI answers only with the sender's own key. Without one the message is still delivered to the people.
  let skip: SkipReason | null = null;
  if (mentions.length > 0) skip = "mention";
  else if (!provider || !model || !(await listKeyHints(userId)).some((k) => k.provider === provider)) skip = "no_key";

  // The sender's own uploaded, unsent pictures of this chat are attached to this message.
  if (!(await claimImages(userId, chatId, id, imageIds))) return c.json({ error: "One of the pictures is no longer available. Add it again." }, 400);

  const { error } = await admin.from("messages").insert({
    id,
    chat_id: chatId,
    author_id: userId,
    role: "user",
    kind: "message",
    status: skip ? "done" : "pending",
    content,
    provider: provider ?? null,
    model: model ?? null,
    reasoning: reasoning ?? null,
    mentions,
    reply_to: replyTo ?? null,
    meta,
    skip_reason: skip,
    images: imageIds,
  });
  if (error) {
    await releaseImages(id);
    return c.json({ error: "Could not send the message" }, 400);
  }

  // A new chat is named after its first message: by the AI with the sender's key, or by its first words when that can't be done.
  if (chat.title === DEFAULT_CHAT_TITLE) {
    // Words name the chat; pictures alone give the AI nothing to name it from.
    const titleModel = skip || !provider || !model || content === IMAGE_ONLY_TEXT ? null : { provider, model };
    // A design marker is written by the app, not by the person: the chat is named from the words after it.
    const marked = parseDesignMarker(content);
    const words = marked ? marked.rest.trim() || (marked.ref.path ? `Design ${marked.ref.path.split("/").at(-1)}` : "Design") : content;
    void nameChat(chatId, userId, content === IMAGE_ONLY_TEXT ? "Image" : words, titleModel).catch((e) => console.error(`[title] chat ${chatId}:`, e));
  }

  if (!skip) void processChatQueue(chatId).catch((e) => console.error(`[run] chat ${chatId}:`, e));
  return c.json({ id, skipped: skip } satisfies SendMessageResponse);
});

// Uploads one picture to a chat (the raw file as the body). The client picks the id so the message that carries it can show
// the picture before the upload is done. It stays unsent until a message claims it.
chats.post("/:id/images", rateLimit("image-upload", 30, 60_000), async (c) => {
  const chatId = c.req.param("id");
  const id = c.req.query("id");
  if (!uuid.safeParse(chatId).success || !id || !uuid.safeParse(id).success) return c.json({ error: "Invalid request" }, 400);
  const userId = c.get("userId");
  if (!(await canAccess(userId, chatId))) return c.json({ error: NOT_FOUND }, 404);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const stored = await storeImage(userId, chatId, id, bytes);
  return stored.ok ? c.json({ id: stored.id }) : c.json({ error: stored.error }, stored.status);
});

// Addresses for showing pictures of a chat. Only members get them, and ids from other chats are left out.
chats.post("/:id/images/urls", async (c) => {
  const chatId = c.req.param("id");
  const parsed = imageUrlsBody.safeParse(await c.req.json().catch(() => null));
  if (!uuid.safeParse(chatId).success || !parsed.success) return c.json({ error: "Invalid request" }, 400);
  if (!(await canAccess(c.get("userId"), chatId))) return c.json({ error: NOT_FOUND }, 404);
  return c.json({ urls: await signedUrls(chatId, parsed.data.ids) } satisfies ImageUrlsResponse);
});

// Asks for a recap. It runs in the same queue as questions, with the requester's key, and posts for everyone.
chats.post("/:id/summarize", rateLimit("summarize", 10, 60_000), async (c) => {
  const chatId = c.req.param("id");
  const parsed = summarizeBody.safeParse(await c.req.json().catch(() => null));
  if (!uuid.safeParse(chatId).success || !parsed.success) return c.json({ error: "Invalid request" }, 400);
  const userId = c.get("userId");
  const { id, scope, provider, model, reasoning } = parsed.data;
  if (!(await canAccess(userId, chatId))) return c.json({ error: NOT_FOUND }, 404);
  if (!(await listKeyHints(userId)).some((k) => k.provider === provider)) {
    return c.json({ error: isPlanProvider(provider) ? `Connect your ${PROVIDER_LABELS[provider]} in Settings to summarize.` : `Add your ${PROVIDER_LABELS[provider]} API key in Settings to summarize.` }, 400);
  }

  let fromSeq = 0;
  if (scope === "unread" && parsed.data.fromSeq !== undefined) {
    fromSeq = parsed.data.fromSeq;
  } else if (scope === "unread") {
    const { data } = await admin.from("chat_reads").select("last_seq").eq("chat_id", chatId).eq("user_id", userId).maybeSingle();
    fromSeq = Number(data?.last_seq ?? 0);
  } else if (scope === "day") {
    const { data } = await admin
      .from("messages")
      .select("seq")
      .eq("chat_id", chatId)
      .gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString())
      .order("seq")
      .limit(1);
    fromSeq = data?.[0] ? Number(data[0].seq) - 1 : Number.MAX_SAFE_INTEGER;
  }
  const { count } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("chat_id", chatId)
    .in("kind", ["message", "summary"])
    .eq("status", "done")
    .gt("seq", fromSeq);
  if (!count) return c.json({ error: "There is nothing to summarize in that range." }, 400);

  const { error } = await admin.from("messages").insert({
    id,
    chat_id: chatId,
    author_id: userId,
    role: "user",
    kind: "summary_request",
    status: "pending",
    content: "Summarize",
    provider,
    model,
    reasoning: reasoning ?? null,
    meta: { scope, from_seq: fromSeq, count },
  });
  if (error) return c.json({ error: "Could not start the summary" }, 400);
  void processChatQueue(chatId).catch((e) => console.error(`[run] chat ${chatId}:`, e));
  return c.json({ id });
});

// Stops the answer that is being written for the caller. What was written so far stays.
chats.post("/:id/stop", async (c) => {
  if (!uuid.safeParse(c.req.param("id")).success) return c.json({ error: "Invalid request" }, 400);
  return c.json({ stopped: stopRun(c.req.param("id"), c.get("userId")) });
});

// Runs the question(s) behind an answer again with the same person's key. Only the person it was for can do this.
messages.post("/:id/retry", rateLimit("retry", 20, 60_000), async (c) => {
  const id = c.req.param("id");
  if (!uuid.safeParse(id).success) return c.json({ error: "Invalid request" }, 400);
  const userId = c.get("userId");
  const { data: answer } = await admin
    .from("messages")
    .select("id, chat_id, role, status, for_user_id, run_id")
    .eq("id", id)
    .maybeSingle();
  if (!answer || !(await canAccess(userId, answer.chat_id as string))) return c.json({ error: NOT_FOUND }, 404);
  if (answer.role !== "assistant" || answer.for_user_id !== userId) return c.json({ error: "Only the person this answer was for can retry it." }, 403);
  if (answer.status !== "done" && answer.status !== "error") return c.json({ error: "That answer is still being written." }, 409);
  if (!answer.run_id) return c.json({ error: "This answer can't be retried." }, 400);
  if (!(await listKeyHints(userId)).length) return c.json({ error: "Add an AI key in Settings first." }, 400);

  await admin.from("messages").update({ status: "pending", run_id: null }).eq("run_id", answer.run_id).eq("role", "user");
  await admin.from("messages").delete().eq("id", id);
  void processChatQueue(answer.chat_id as string).catch((e) => console.error(`[run] chat ${answer.chat_id}:`, e));
  return c.json({ ok: true });
});
