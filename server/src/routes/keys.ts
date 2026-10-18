import { isPlanProvider, isProvider, PROVIDER_LABELS, type ChatGptPollResponse, type ChatGptStartResponse, type KeysResponse, type ModelsResponse } from "@mc/shared";
import { Hono } from "hono";
import { z } from "zod";
import { rateLimit, type AuthVars } from "../auth.ts";
import { deleteUserKey, getUserKey, listKeyHints, saveUserKey } from "../keys.ts";
import { getUsage, pollSignIn, startSignIn } from "../chatgpt.ts";
import { supabaseLoginStore } from "../chatgpt-store.ts";
import { forgetOpenRouterUsage, getOpenRouterUsage } from "../openrouter-usage.ts";
import { listModels, ProviderError, verifyKey } from "../providers.ts";

export const keys = new Hono<AuthVars>();

// ChatGPT plan sign-in (unofficial, device code): start shows a code, poll waits for the user to approve it on OpenAI's page.
const flowBody = z.object({ flow: z.string().min(10).max(2000) });
function planError(e: unknown): string {
  if (e instanceof ProviderError) return e.message;
  console.error("[chatgpt]", e instanceof Error ? e.message : "unknown error"); // our own messages only: no tokens are ever put in one
  return "Something went wrong. Try again.";
}

keys.post("/chatgpt/start", rateLimit("chatgpt-start", 5, 60_000), async (c) => {
  try {
    return c.json((await startSignIn(c.get("userId"))) satisfies ChatGptStartResponse);
  } catch (e) {
    return c.json({ error: planError(e) }, 502);
  }
});

// How much of their own plan's limits this user has used. Read only, and only ever for the caller's own sign-in.
keys.get("/chatgpt/usage", rateLimit("chatgpt-usage", 20, 60_000), async (c) => {
  try {
    const userId = c.get("userId");
    const token = await getUserKey(userId, "chatgpt");
    if (!token) return c.json({ error: "Connect your ChatGPT plan first." }, 400);
    return c.json(await getUsage(userId, token, c.req.query("refresh") === "1"));
  } catch (e) {
    return c.json({ error: planError(e) }, 502);
  }
});

// How much of their own OpenRouter key is used. Read only, only ever for the caller's own key, which never leaves the server.
keys.get("/openrouter/usage", rateLimit("openrouter-usage", 20, 60_000), async (c) => {
  try {
    const userId = c.get("userId");
    const apiKey = await getUserKey(userId, "openrouter");
    if (!apiKey) return c.json({ error: "Add your OpenRouter API key first." }, 400);
    return c.json(await getOpenRouterUsage(userId, apiKey, c.req.query("refresh") === "1"));
  } catch (e) {
    return c.json({ error: planError(e) }, 502);
  }
});

keys.post("/chatgpt/poll", rateLimit("chatgpt-poll", 40, 60_000), async (c) => {
  const parsed = flowBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
  try {
    return c.json((await pollSignIn(supabaseLoginStore, c.get("userId"), parsed.data.flow)) satisfies ChatGptPollResponse);
  } catch (e) {
    return c.json({ error: planError(e) }, 502);
  }
});

keys.get("/keys", async (c) => c.json({ keys: await listKeyHints(c.get("userId")) } satisfies KeysResponse));

const keyBody = z.object({ apiKey: z.string().trim().min(8).max(500) });

keys.put("/keys/:provider", rateLimit("keys", 10, 60_000), async (c) => {
  const provider = c.req.param("provider");
  const parsed = keyBody.safeParse(await c.req.json().catch(() => null));
  if (!isProvider(provider) || !parsed.success) return c.json({ error: "Invalid key" }, 400);
  if (isPlanProvider(provider)) return c.json({ error: `${PROVIDER_LABELS[provider]} is connected by signing in, not with a key.` }, 400);
  try {
    await verifyKey(provider, parsed.data.apiKey);
  } catch (e) {
    return c.json({ error: e instanceof ProviderError ? e.message : "Could not check the key" }, 400);
  }
  const hint = await saveUserKey(c.get("userId"), provider, parsed.data.apiKey);
  return c.json({ provider, hint });
});

keys.delete("/keys/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider)) return c.json({ error: "Unknown provider" }, 400);
  await deleteUserKey(c.get("userId"), provider);
  return c.json({ ok: true });
});

keys.get("/models/:provider", rateLimit("models", 20, 60_000), async (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider)) return c.json({ error: "Unknown provider" }, 400);
  try {
    const apiKey = await getUserKey(c.get("userId"), provider);
    if (!apiKey) return c.json({ error: isPlanProvider(provider) ? "Connect your ChatGPT plan first." : `Add your ${PROVIDER_LABELS[provider]} API key first.` }, 400);
    return c.json({ models: await listModels(provider, apiKey) } satisfies ModelsResponse);
  } catch (e) {
    return c.json({ error: e instanceof ProviderError ? e.message : "Could not load models" }, 502);
  }
});
