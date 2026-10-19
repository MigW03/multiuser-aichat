import { FOLDER_LIMITS as L } from "@mc/shared";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { rateLimit, type AuthVars } from "../auth.ts";
import { dbError } from "../errors.ts";
import { RelayError } from "../folder-relay.ts";
import { folderAccess, hub, pushOwnerItems } from "../folders.ts";
import { admin } from "../supabase.ts";

// The project's shared files: several folders and files, each shared by one person from their own computer. Every member
// can browse them (read only), the host and admins approve what members ask to share, and an item's owner (or the host
// or an admin) can stop sharing it. Sharing itself starts in the owner's desktop app, over its connection (folder-relay.ts).
// Reads go to the owner's app through the hub; the server stores no file contents.

export const folder = new Hono<AuthVars>();

const uuid = z.uuid();
const decisionBody = z.object({ approve: z.boolean() });
const pathParam = z.string().max(L.pathChars).default("");
const listQuery = z.object({ path: pathParam });
const readQuery = z.object({ path: z.string().min(1).max(L.pathChars), offset: z.coerce.number().int().min(1).max(10_000_000).optional(), limit: z.coerce.number().int().min(1).max(L.readLines).optional() });

const HOST_STATUS: Record<string, ContentfulStatusCode> = {
  invalid_path: 400, bad_request: 400, not_found: 404, not_a_file: 400, not_a_directory: 400, excluded: 403, too_large: 413, binary: 415, timeout: 504, busy: 503, failed: 502,
  disabled: 403, no_repo: 404, git_unsafe: 409, git_failed: 502, nothing: 400, no_match: 400, ambiguous: 400, secrets: 400, stale: 409, denied: 403, expired: 408, exists: 409,
};

/** Maps a failed relay call to a response whose message is safe to show to any project member. */
export function relayFailure(c: Context, e: unknown) {
  if (e instanceof RelayError) {
    if (e.kind === "offline") return c.json({ error: "The desktop app of the person who shares this is offline, so it is unavailable right now.", code: "folder_offline" }, 503);
    if (e.kind === "busy") return c.json({ error: e.message, code: "folder_busy" }, 503);
    if (e.kind === "timeout") return c.json({ error: e.message, code: "folder_timeout" }, 504);
    if (e.kind === "host") return c.json({ error: e.message, code: e.code ?? "failed" }, HOST_STATUS[e.code ?? "failed"] ?? 502);
    return c.json({ error: "The shared folder gave an answer that could not be used.", code: "folder_bad_answer" }, 502);
  }
  console.error("[folder]", e);
  return c.json({ error: "Something went wrong" }, 500);
}

// The host or an admin answers a member's request to share something.
folder.post("/:id/shares/:share/decision", rateLimit("share-decide", 60, 60 * 60_000), async (c) => {
  const parsed = decisionBody.safeParse(await c.req.json().catch(() => null));
  const id = uuid.safeParse(c.req.param("id"));
  const share = uuid.safeParse(c.req.param("share"));
  if (!id.success || !share.success || !parsed.success) return c.json({ error: "Invalid request" }, 400);
  const { data, error } = await admin.rpc("app_share_decide", { p_user: c.get("userId"), p_project: id.data, p_share: share.data, p_approve: parsed.data.approve });
  if (error) return dbError(c, error);
  if (typeof data === "string") await pushOwnerItems(id.data, data).catch((e) => console.error("[folder] could not update the owner's app:", e));
  return c.json({ ok: true });
});

// Stops sharing one item: its owner may, and so may the host and admins. The owner's app stops serving it at once.
folder.delete("/:id/shares/:share", rateLimit("share-remove", 60, 60 * 60_000), async (c) => {
  const id = uuid.safeParse(c.req.param("id"));
  const share = uuid.safeParse(c.req.param("share"));
  if (!id.success || !share.success) return c.json({ error: "Invalid request" }, 400);
  const { data, error } = await admin.rpc("app_share_remove", { p_user: c.get("userId"), p_project: id.data, p_share: share.data });
  if (error) return dbError(c, error);
  if (typeof data === "string") await pushOwnerItems(id.data, data).catch((e) => console.error("[folder] could not update the owner's app:", e));
  return c.json({ ok: true });
});

// The permission check for every read: the caller must belong to the project, and a folder must be shared in it.
folder.use("/:id/folder/*", rateLimit("folder-read", 150, 60_000), async (c, next) => {
  const id = uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "Invalid request" }, 400);
  const access = await folderAccess(c.get("userId"), id.data);
  if (!access.ok) {
    return access.reason === "not_linked"
      ? c.json({ error: "No folder is shared in this project.", code: "not_linked" }, 404)
      : c.json({ error: "That doesn't exist, or you don't have access to it." }, 404);
  }
  await next();
});

folder.get("/:id/folder/list", async (c) => {
  const q = listQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "Invalid request" }, 400);
  try {
    return c.json(await hub.call(c.req.param("id"), { op: "list", path: q.data.path }));
  } catch (e) {
    return relayFailure(c, e);
  }
});

folder.get("/:id/folder/read", async (c) => {
  const q = readQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "Invalid request" }, 400);
  try {
    return c.json(await hub.call(c.req.param("id"), { op: "read", path: q.data.path, offset: q.data.offset, limit: q.data.limit }));
  } catch (e) {
    return relayFailure(c, e);
  }
});

// Git, read only: the same members may see what changed (status, one diff). Only when an owner switched git on.
const gitQuery = z.object({ path: pathParam.optional(), target: z.enum(["worktree", "staged", "head"]).optional() });

folder.use("/:id/folder/git/*", async (c, next) => {
  if (!(await hub.caps(c.req.param("id"))).git) return c.json({ error: "Git is not switched on for this project.", code: "git_off" }, 404);
  await next();
});

folder.get("/:id/folder/git/status", async (c) => {
  const q = gitQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "Invalid request" }, 400);
  try {
    return c.json(await hub.call(c.req.param("id"), { op: "git", sub: "status", ...(q.data.path ? { path: q.data.path } : {}) }));
  } catch (e) {
    return relayFailure(c, e);
  }
});

folder.get("/:id/folder/git/diff", async (c) => {
  const q = gitQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "Invalid request" }, 400);
  try {
    return c.json(await hub.call(c.req.param("id"), { op: "git", sub: "diff", ...(q.data.target ? { target: q.data.target } : {}), ...(q.data.path ? { path: q.data.path } : {}) }));
  } catch (e) {
    return relayFailure(c, e);
  }
});
