import { serve } from "@hono/node-server";
import { isProvider, LIMITS, PROVIDER_IDS, PROVIDER_LABELS, type KeysResponse, type ModelsResponse, type SendMessageResponse } from "@mc/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { rateLimit, requireUser, type AuthVars } from "./auth.ts";
import { env } from "./env.ts";
import { deleteUserKey, getUserKey, listKeyHints, saveUserKey } from "./keys.ts";
import { listModels, ProviderError, verifyKey } from "./providers.ts";
import { processChatQueue } from "./run-queue.ts";
import { admin } from "./supabase.ts";

const app = new Hono<AuthVars>();

app.use(secureHeaders());
// Auth is a bearer token, not a cookie, so CORS isn't what protects the API; it only keeps other sites from using it in a browser.
app.use("/api/*", cors({ origin: env.allowedOrigins, allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "PUT", "DELETE"] }));
app.use("/api/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }));

app.get("/health", (c) => c.json({ ok: true }));

app.use("/api/*", requireUser);

const uuid = z.uuid();
const sendBody = z.object({
  id: z.uuid(), // chosen by the client so its optimistic copy matches the saved row
  content: z.string().trim().min(1).max(LIMITS.messageChars),
  provider: z.enum(PROVIDER_IDS),
  model: z.string().regex(LIMITS.modelIdPattern),
});

app.post("/api/chats/:chatId/messages", rateLimit("send", 30, 60_000), async (c) => {
  const chatId = c.req.param("chatId");
  const parsed = sendBody.safeParse(await c.req.json().catch(() => null));
  if (!uuid.safeParse(chatId).success || !parsed.success) return c.json({ error: "Invalid message" }, 400);
  const userId = c.get("userId");
  const { id, content, provider, model } = parsed.data;

  // Refuse early when the AI couldn't answer anyway.
  if (!(await listKeyHints(userId)).some((k) => k.provider === provider)) {
    return c.json({ error: `Add your ${PROVIDER_LABELS[provider]} API key under API keys to use it.` }, 400);
  }
  const { data: member } = await admin.from("chat_members").select("user_id").eq("chat_id", chatId).eq("user_id", userId).maybeSingle();
  if (!member) return c.json({ error: "You are not in this chat" }, 403);

  const { error } = await admin.from("messages").insert({ id, chat_id: chatId, author_id: userId, role: "user", status: "pending", content, provider, model });
  if (error) return c.json({ error: "Could not send the message" }, 400);

  void processChatQueue(chatId).catch((e) => console.error(`[run] chat ${chatId}:`, e));
  return c.json({ id } satisfies SendMessageResponse);
});

app.get("/api/keys", async (c) => c.json({ keys: await listKeyHints(c.get("userId")) } satisfies KeysResponse));

const keyBody = z.object({ apiKey: z.string().trim().min(8).max(500) });

app.put("/api/keys/:provider", rateLimit("keys", 10, 60_000), async (c) => {
  const provider = c.req.param("provider");
  const parsed = keyBody.safeParse(await c.req.json().catch(() => null));
  if (!isProvider(provider) || !parsed.success) return c.json({ error: "Invalid key" }, 400);
  try {
    await verifyKey(provider, parsed.data.apiKey);
  } catch (e) {
    return c.json({ error: e instanceof ProviderError ? e.message : "Could not check the key" }, 400);
  }
  const hint = await saveUserKey(c.get("userId"), provider, parsed.data.apiKey);
  return c.json({ provider, hint });
});

app.delete("/api/keys/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider)) return c.json({ error: "Unknown provider" }, 400);
  await deleteUserKey(c.get("userId"), provider);
  return c.json({ ok: true });
});

app.get("/api/models/:provider", rateLimit("models", 20, 60_000), async (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider)) return c.json({ error: "Unknown provider" }, 400);
  const apiKey = await getUserKey(c.get("userId"), provider);
  if (!apiKey) return c.json({ error: `Add your ${PROVIDER_LABELS[provider]} API key first.` }, 400);
  try {
    return c.json({ models: await listModels(provider, apiKey) } satisfies ModelsResponse);
  } catch (e) {
    return c.json({ error: e instanceof ProviderError ? e.message : "Could not load models" }, 502);
  }
});

app.onError((err, c) => {
  console.error("[server]", err);
  return c.json({ error: "Something went wrong" }, 500);
});

serve({ fetch: app.fetch, port: env.port, hostname: process.env.HOST ?? "127.0.0.1" }, (info) => {
  console.log(`server listening on http://${info.address}:${info.port}`);
});
