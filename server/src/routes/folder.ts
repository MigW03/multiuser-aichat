import { FOLDER_LIMITS as L } from "@mc/shared";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { rateLimit, type AuthVars } from "../auth.ts";
import { dbError } from "../errors.ts";
import { RelayError } from "../folder-relay.ts";
import { folderAccess, relay } from "../folders.ts";
import { admin } from "../supabase.ts";

// The project's shared folder: the host links and unlinks it, every member can browse it (read only). Reads go to the
// host's desktop app through the relay; the server stores no file contents.

export const folder = new Hono<AuthVars>();

const uuid = z.uuid();
const nameBody = z.object({ name: z.string().trim().min(1).max(L.nameChars) });
const pathParam = z.string().max(L.pathChars).default("");
const listQuery = z.object({ path: pathParam });
const readQuery = z.object({ path: z.string().min(1).max(L.pathChars), offset: z.coerce.number().int().min(1).max(10_000_000).optional(), limit: z.coerce.number().int().min(1).max(L.readLines).optional() });
const searchQuery = z.object({ q: z.string().min(1).max(L.searchQueryChars), path: pathParam, glob: z.string().max(60).optional() });

const HOST_STATUS: Record<string, ContentfulStatusCode> = {
  invalid_path: 400, bad_request: 400, not_found: 404, not_a_file: 400, not_a_directory: 400, excluded: 403, too_large: 413, binary: 415, busy: 503, failed: 502,
};

/** Maps a failed relay call to a response whose message is safe to show to any project member. */
export function relayFailure(c: Context, e: unknown) {
  if (e instanceof RelayError) {
    if (e.kind === "offline") return c.json({ error: "The project host's desktop app is offline, so the shared folder is unavailable right now.", code: "folder_offline" }, 503);
    if (e.kind === "busy") return c.json({ error: e.message, code: "folder_busy" }, 503);
    if (e.kind === "timeout") return c.json({ error: e.message, code: "folder_timeout" }, 504);
    if (e.kind === "host") return c.json({ error: e.message, code: e.code ?? "failed" }, HOST_STATUS[e.code ?? "failed"] ?? 502);
    return c.json({ error: "The shared folder gave an answer that could not be used.", code: "folder_bad_answer" }, 502);
  }
  console.error("[folder]", e);
  return c.json({ error: "Something went wrong" }, 500);
}

folder.put("/:id/folder", rateLimit("folder-link", 20, 60 * 60_000), async (c) => {
  const parsed = nameBody.safeParse(await c.req.json().catch(() => null));
  if (!uuid.safeParse(c.req.param("id")).success || !parsed.success) return c.json({ error: "Invalid request" }, 400);
  const { error } = await admin.rpc("app_link_folder", { p_user: c.get("userId"), p_project: c.req.param("id"), p_name: parsed.data.name });
  return error ? dbError(c, error) : c.json({ ok: true });
});

folder.delete("/:id/folder", async (c) => {
  const id = c.req.param("id");
  if (!uuid.safeParse(id).success) return c.json({ error: "Invalid request" }, 400);
  const { error } = await admin.rpc("app_unlink_folder", { p_user: c.get("userId"), p_project: id });
  if (error) return dbError(c, error);
  relay.disconnect(id); // the host's app stops serving at once
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
    return c.json(await relay.call(c.req.param("id"), { op: "list", path: q.data.path }));
  } catch (e) {
    return relayFailure(c, e);
  }
});

folder.get("/:id/folder/read", async (c) => {
  const q = readQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "Invalid request" }, 400);
  try {
    return c.json(await relay.call(c.req.param("id"), { op: "read", path: q.data.path, offset: q.data.offset, limit: q.data.limit }));
  } catch (e) {
    return relayFailure(c, e);
  }
});

folder.get("/:id/folder/search", async (c) => {
  const q = searchQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "Invalid request" }, 400);
  try {
    return c.json(await relay.call(c.req.param("id"), { op: "search", query: q.data.q, path: q.data.path, glob: q.data.glob }));
  } catch (e) {
    return relayFailure(c, e);
  }
});
