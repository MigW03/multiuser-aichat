import { isProvider, PROVIDER_LABELS, type KeysResponse, type ModelsResponse } from "@mc/shared";
import { Hono } from "hono";
import { z } from "zod";
import { rateLimit, type AuthVars } from "../auth.ts";
import { deleteUserKey, getUserKey, listKeyHints, saveUserKey } from "../keys.ts";
import { listModels, ProviderError, verifyKey } from "../providers.ts";

export const keys = new Hono<AuthVars>();

keys.get("/keys", async (c) => c.json({ keys: await listKeyHints(c.get("userId")) } satisfies KeysResponse));

const keyBody = z.object({ apiKey: z.string().trim().min(8).max(500) });

keys.put("/keys/:provider", rateLimit("keys", 10, 60_000), async (c) => {
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

keys.delete("/keys/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider)) return c.json({ error: "Unknown provider" }, 400);
  await deleteUserKey(c.get("userId"), provider);
  return c.json({ ok: true });
});

keys.get("/models/:provider", rateLimit("models", 20, 60_000), async (c) => {
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
