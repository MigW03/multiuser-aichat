import { createMiddleware } from "hono/factory";
import { admin } from "./supabase.ts";

export type AuthVars = { Variables: { userId: string; token: string } };

/** Requires `Authorization: Bearer <Supabase access token>` and checks it with Supabase Auth. */
export const requireUser = createMiddleware<AuthVars>(async (c, next) => {
  const token = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return c.json({ error: "Not signed in" }, 401);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return c.json({ error: "Not signed in" }, 401);
  c.set("userId", data.user.id);
  c.set("token", token);
  await next();
});

/** A small in-memory limiter per user and route. Enough for one server instance. */
export function rateLimit(name: string, max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return createMiddleware<AuthVars>(async (c, next) => {
    const key = `${name}:${c.get("userId")}`;
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return c.json({ error: "Too many requests. Wait a moment and try again." }, 429);
    recent.push(now);
    hits.set(key, recent);
    await next();
  });
}
