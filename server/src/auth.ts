import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { env } from "./env.ts";
import { admin } from "./supabase.ts";

export type AuthVars = { Variables: { userId: string; token: string } };

async function userIdFor(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  return error || !data.user ? null : data.user.id;
}

const bearer = (c: Context) => c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];

/** Requires `Authorization: Bearer <Supabase access token>` and checks it with Supabase Auth. */
export const requireUser = createMiddleware<AuthVars>(async (c, next) => {
  const token = bearer(c);
  const userId = await userIdFor(token);
  if (!token || !userId) return c.json({ error: "Not signed in" }, 401);
  c.set("userId", userId);
  c.set("token", token);
  await next();
});

/** For routes that work signed out: the user id, or null when there is no valid token. */
export async function optionalUserId(c: Context): Promise<string | null> {
  return userIdFor(bearer(c));
}

function clientIp(c: Context): string {
  if (env.trustProxy) {
    const forwarded = c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** A small in-memory limiter. Enough for one server instance. `by` picks the key: the signed-in user or the client address. */
export function rateLimit(name: string, max: number, windowMs: number, by: "user" | "ip" = "user") {
  const hits = new Map<string, number[]>();
  return createMiddleware(async (c, next) => {
    const who = by === "user" ? ((c as Context<AuthVars>).get("userId") as string | undefined) ?? clientIp(c) : clientIp(c);
    const key = `${name}:${who}`;
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return c.json({ error: "Too many requests. Wait a moment and try again." }, 429);
    recent.push(now);
    hits.set(key, recent);
    // Drop idle keys so the map can't grow without bound.
    if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
    await next();
  });
}
