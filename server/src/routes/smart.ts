import type { SmartKeyStatus, SmartSet, SmartSettings } from "@mc/shared";
import { Hono } from "hono";
import { z } from "zod";
import { rateLimit, type AuthVars } from "../auth.ts";
import { admin } from "../supabase.ts";
import { checkSmartKey, getSmartSet, isSmartOn, saveSmartSet, setSmartOn } from "../smart.ts";
import { cleanSmartSet } from "../smart-rules.ts";

// Smart model selection: each person's own switch for a project, and their own set of models. Nothing here ever reads or
// changes anyone else's, and the OpenRouter key stays on the server.

export const smart = new Hono<AuthVars>();

const uuid = z.uuid();
const NOT_FOUND = "That doesn't exist, or you don't have access to it.";
const KEY_TEXT: Record<Exclude<SmartKeyStatus, "ok">, string> = {
  no_key: "Smart model selection needs your OpenRouter API key. Add it in Settings first.",
  invalid_key: "OpenRouter rejected your key. Update it in Settings first.",
  no_credits: "Your OpenRouter key has no credits left. Add credits on OpenRouter, then try again.",
  unreachable: "Could not reach OpenRouter to check your key. Try again in a moment.",
};

async function inProject(userId: string, projectId: string): Promise<boolean> {
  const { data } = await admin.rpc("project_role_of", { p_user: userId, p_project: projectId });
  return !!data;
}

smart.get("/smart/set", async (c) => c.json({ models: await getSmartSet(c.get("userId")) } satisfies SmartSet));

smart.put("/smart/set", rateLimit("smart-set", 60, 60_000), async (c) => {
  const parsed = z.object({ models: z.array(z.string()) }).safeParse(await c.req.json().catch(() => null));
  const models = parsed.success ? cleanSmartSet(parsed.data.models) : null;
  if (!models) return c.json({ error: "That list of models isn't valid." }, 400);
  try {
    await saveSmartSet(c.get("userId"), models);
  } catch (e) {
    console.error("[smart]", e instanceof Error ? e.message : e);
    return c.json({ error: "Something went wrong" }, 500);
  }
  return c.json({ models } satisfies SmartSet);
});

// This person's switch for the project. `?check=1` also says whether their OpenRouter key is ready for it.
smart.get("/projects/:id/smart", rateLimit("smart-state", 60, 60_000), async (c) => {
  const id = c.req.param("id");
  const userId = c.get("userId");
  if (!uuid.safeParse(id).success || !(await inProject(userId, id))) return c.json({ error: NOT_FOUND }, 404);
  const [enabled, key] = await Promise.all([isSmartOn(userId, id), c.req.query("check") === "1" ? checkSmartKey(userId) : Promise.resolve(undefined)]);
  return c.json({ enabled, ...(key ? { key } : {}) } satisfies SmartSettings);
});

// Turning it on needs an OpenRouter key that works and has credit as far as OpenRouter lets us see (see creditStatus).
smart.put("/projects/:id/smart", rateLimit("smart-switch", 30, 60_000), async (c) => {
  const id = c.req.param("id");
  const userId = c.get("userId");
  const parsed = z.object({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!uuid.safeParse(id).success || !parsed.success) return c.json({ error: "Invalid request" }, 400);
  if (!(await inProject(userId, id))) return c.json({ error: NOT_FOUND }, 404);
  if (parsed.data.enabled) {
    const key = await checkSmartKey(userId);
    if (key !== "ok") return c.json({ error: KEY_TEXT[key], code: `smart_${key}` }, key === "unreachable" ? 502 : 400);
  }
  if (!(await setSmartOn(userId, id, parsed.data.enabled))) return c.json({ error: NOT_FOUND }, 404);
  return c.json({ enabled: parsed.data.enabled, key: "ok" } satisfies SmartSettings);
});
