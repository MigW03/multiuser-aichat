import type { SmartKeyStatus, SmartSettings } from "@mc/shared";
import { Hono } from "hono";
import { z } from "zod";
import { rateLimit, type AuthVars } from "../auth.ts";
import { checkSmartKey, getSmart, saveSmartSet, setSmartOn } from "../smart.ts";
import { cleanSmartSet } from "../smart-rules.ts";

// Smart model selection: this person's own switch and set of models. Nothing here reads or changes anyone else's, and the
// OpenRouter key stays on the server.

export const smart = new Hono<AuthVars>();

const KEY_TEXT: Record<Exclude<SmartKeyStatus, "ok">, string> = {
  no_key: "Smart model selection needs your OpenRouter API key. Add it under AI key first.",
  invalid_key: "OpenRouter rejected your key. Update it under AI key first.",
  no_credits: "Your OpenRouter key has no credits left. Add credits on OpenRouter, then try again.",
  unreachable: "Could not reach OpenRouter to check your key. Try again in a moment.",
};

/** Database failures are logged here and shown generically. */
function failed(e: unknown) {
  console.error("[smart]", e instanceof Error ? e.message : e);
  return { error: "Could not save that. Try again in a moment." };
}

// The switch and the set. `?check=1` also says whether the OpenRouter key is ready for it.
smart.get("/smart", rateLimit("smart-state", 60, 60_000), async (c) => {
  const userId = c.get("userId");
  try {
    const [state, key] = await Promise.all([getSmart(userId), c.req.query("check") === "1" ? checkSmartKey(userId) : Promise.resolve(undefined)]);
    return c.json({ ...state, ...(key ? { key } : {}) } satisfies SmartSettings);
  } catch (e) {
    return c.json(failed(e), 500);
  }
});

// Turning it on needs an OpenRouter key that works and has credit as far as OpenRouter lets us see (see creditStatus).
smart.put("/smart/enabled", rateLimit("smart-switch", 30, 60_000), async (c) => {
  const userId = c.get("userId");
  const parsed = z.object({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
  if (parsed.data.enabled) {
    const key = await checkSmartKey(userId);
    if (key !== "ok") return c.json({ error: KEY_TEXT[key], code: `smart_${key}` }, key === "unreachable" ? 502 : 400);
  }
  try {
    await setSmartOn(userId, parsed.data.enabled);
    return c.json({ ...(await getSmart(userId)), key: "ok" } satisfies SmartSettings);
  } catch (e) {
    return c.json(failed(e), 500);
  }
});

smart.put("/smart/set", rateLimit("smart-set", 60, 60_000), async (c) => {
  const parsed = z.object({ models: z.array(z.string()) }).safeParse(await c.req.json().catch(() => null));
  const models = parsed.success ? cleanSmartSet(parsed.data.models) : null;
  if (!models) return c.json({ error: "That list of models isn't valid." }, 400);
  try {
    await saveSmartSet(c.get("userId"), models);
    return c.json(await getSmart(c.get("userId")) satisfies Omit<SmartSettings, "key">);
  } catch (e) {
    return c.json(failed(e), 500);
  }
});
