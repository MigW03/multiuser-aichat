import { FILE_STORE_LIMITS as L, type StoredDownload, type StoredEntry, type StoredList, type StoredUpload } from "@mc/shared";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { rateLimit, type AuthVars } from "../auth.ts";
import { downloadName, objectKey, PathError, projectPrefix, relativeTo, sharePrefix, splitStoredPath } from "../file-paths.ts";
import { containsSecret } from "../file-scan.ts";
import { activeShareFor } from "../folders.ts";
import { objectStore, StorageOffError, type ObjectStore, type Usage } from "../r2.ts";
import type { Share } from "../folder-hub.ts";

// The stored copy of a project's shared files (Cloudflare R2), so they stay available when their owner's computer is off.
// An item's owner uploads and deletes the files of their own approved items; every project member lists and downloads them.
// A download is a short-lived address that R2 serves as an attachment, so the bytes never pass through this server.

const uuid = z.uuid();
const pathQuery = z.object({ path: z.string().max(400).default("") });

const NOT_FOUND = { error: "That doesn't exist, or you don't have access to it." };
/** Uploads held in memory at once. A file is read whole before it is stored. */
const UPLOADS_AT_ONCE = 3;
const USAGE_TTL_MS = 30_000;

export type FilesDeps = {
  store?: () => ObjectStore;
  /** Whether the person belongs to the project, and the project's approved item with this id. */
  access?: (userId: string, projectId: string, shareId: string) => Promise<{ ok: true; share: Share } | { ok: false }>;
  /** Tests only: the routes are called many times in a row. */
  noRateLimits?: boolean;
};

export function createFilesRoutes(deps: FilesDeps = {}) {
  const store = deps.store ?? objectStore;
  const access = deps.access ?? activeShareFor;
  const limit = (name: string, max: number, windowMs: number) => (deps.noRateLimits ? createMiddleware(async (_c, next) => next()) : rateLimit(name, max, windowMs));
  const files = new Hono<AuthVars>();
  const usage = new Map<string, { at: number; usage: Usage | null }>();
  let uploading = 0;

  async function usageOf(s: ObjectStore, projectId: string): Promise<Usage | null> {
    const hit = usage.get(projectId);
    if (hit && Date.now() - hit.at < USAGE_TTL_MS) return hit.usage;
    const fresh = await s.usage(projectPrefix(projectId), L.projectFiles);
    usage.set(projectId, { at: Date.now(), usage: fresh });
    if (usage.size > 500) for (const [k, v] of usage) if (Date.now() - v.at >= USAGE_TTL_MS) usage.delete(k);
    return fresh;
  }

  // Every route: valid ids, and a person who belongs to the project with this item approved. Storage must be set up.
  files.use("/:id/files/:share/*", async (c, next) => {
    if (!uuid.safeParse(c.req.param("id")).success || !uuid.safeParse(c.req.param("share")).success) return c.json({ error: "Invalid request" }, 400);
    const found = await access(c.get("userId"), c.req.param("id"), c.req.param("share"));
    if (!found.ok) return c.json(NOT_FOUND, 404);
    c.set("share" as never, found.share as never);
    try {
      store();
    } catch (e) {
      if (e instanceof StorageOffError) return c.json({ error: "File storage isn't set up on this server yet.", code: "storage_off" }, 503);
      throw e;
    }
    await next();
  });

  const shareOf = (c: { get: (k: never) => unknown }) => c.get("share" as never) as Share;
  const badPath = (c: { json: (b: unknown, s: 400) => Response }, e: unknown) => {
    if (e instanceof PathError) return c.json({ error: e.message }, 400);
    throw e;
  };
  const failed = (c: { json: (b: unknown, s: 502) => Response }, what: string, e: unknown) => {
    console.error(`[files] ${what} failed:`, e instanceof Error ? `${e.name}: ${e.message}` : "unknown error");
    return c.json({ error: "The file store didn't answer. Try again in a moment." }, 502);
  };

  /** The parts of a file path. An item that is one file stores only that file, under its own name. */
  function filePath(share: Share, input: string): string[] {
    const parts = splitStoredPath(input);
    if (share.kind === "file" && (parts.length !== 1 || parts[0] !== share.name)) throw new PathError("That path isn't valid.");
    return parts;
  }

  // The files and folders directly under a path.
  files.get("/:id/files/:share/list", limit("files-list", 150, 60_000), async (c) => {
    const q = pathQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "Invalid request" }, 400);
    const share = shareOf(c);
    try {
      const s = store();
      const base = sharePrefix(c.req.param("id"), share.id);
      let entries: StoredEntry[];
      let truncated = false;
      if (share.kind === "file") {
        const stored = await s.head(`${base}${share.name}`);
        entries = stored ? [{ name: share.name, kind: "file", bytes: stored.bytes, modified: stored.modified }] : [];
      } else {
        const parts = splitStoredPath(q.data.path, { allowRoot: true, isDir: true });
        const prefix = parts.length ? `${base}${parts.join("/")}/` : base;
        const listing = await s.list(prefix, L.listEntries);
        truncated = listing.truncated;
        entries = [
          ...listing.dirs.map((d) => ({ name: relativeTo(prefix, d).replace(/\/$/, ""), kind: "dir" as const, bytes: 0, modified: null })),
          ...listing.files.map((f) => ({ name: relativeTo(prefix, f.key), kind: "file" as const, bytes: f.bytes, modified: f.modified })),
        ]
          .filter((e) => e.name !== "" && !e.name.includes("/"))
          .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1))
          .slice(0, L.listEntries);
      }
      return c.json({ path: q.data.path, entries, truncated } satisfies StoredList);
    } catch (e) {
      return e instanceof PathError ? badPath(c, e) : failed(c, "list", e);
    }
  });

  // An address that downloads one file for a minute.
  files.get("/:id/files/:share/object", limit("files-get", 150, 60_000), async (c) => {
    const q = pathQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "Invalid request" }, 400);
    try {
      const parts = filePath(shareOf(c), q.data.path);
      const key = objectKey(c.req.param("id"), shareOf(c).id, parts);
      const s = store();
      const found = await s.head(key);
      if (!found) return c.json({ error: "That file isn't stored." }, 404);
      const url = await s.downloadUrl(key, downloadName(parts), L.downloadSeconds);
      c.header("cache-control", "no-store");
      return c.json({ url, bytes: found.bytes, modified: found.modified, expiresInSeconds: L.downloadSeconds } satisfies StoredDownload);
    } catch (e) {
      return e instanceof PathError ? badPath(c, e) : failed(c, "download", e);
    }
  });

  // The owner stores (or replaces) one file. The body is the file itself.
  files.put("/:id/files/:share/object", limit("files-put", 600, 60_000), async (c) => {
    const q = pathQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "Invalid request" }, 400);
    const share = shareOf(c);
    if (share.owner_id !== c.get("userId")) return c.json({ error: "Only the person who shares this can store its files." }, 403);
    let key: string;
    let parts: string[];
    try {
      parts = filePath(share, q.data.path);
      key = objectKey(c.req.param("id"), share.id, parts);
    } catch (e) {
      return badPath(c, e);
    }
    const declared = Number(c.req.header("content-length"));
    if (!Number.isInteger(declared) || declared < 0) return c.json({ error: "Send the file with its length." }, 411);
    if (declared > L.fileBytes) return c.json({ error: `That file is over ${L.fileBytes / 1024 / 1024} MB.` }, 413);
    if (uploading >= UPLOADS_AT_ONCE) return c.json({ error: "Other files are being stored right now. Try again in a moment." }, 429);
    uploading += 1;
    try {
      const body = new Uint8Array(await c.req.arrayBuffer());
      if (body.byteLength > L.fileBytes) return c.json({ error: `That file is over ${L.fileBytes / 1024 / 1024} MB.` }, 413);
      if (containsSecret(body)) return c.json({ error: "That file looks like it holds a secret (a key or token), so it isn't stored.", code: "secrets" }, 422);
      const s = store();
      const [used, existing] = await Promise.all([usageOf(s, c.req.param("id")), s.head(key)]);
      const grows = body.byteLength - (existing?.bytes ?? 0);
      if (!used || used.bytes + grows > L.projectBytes || (!existing && used.files + 1 > L.projectFiles)) {
        return c.json({ error: `This project's stored files are full (${L.projectBytes / 1024 / 1024 / 1024} GB, ${L.projectFiles} files). Remove some first.`, code: "storage_full" }, 409);
      }
      await s.put(key, body, { uploader: c.get("userId") });
      used.bytes += grows;
      if (!existing) used.files += 1;
      return c.json({ path: parts.join("/"), bytes: body.byteLength } satisfies StoredUpload);
    } catch (e) {
      return failed(c, "upload", e);
    } finally {
      uploading -= 1;
    }
  });

  // The owner removes one stored file.
  files.delete("/:id/files/:share/object", limit("files-delete", 600, 60_000), async (c) => {
    const q = pathQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "Invalid request" }, 400);
    const share = shareOf(c);
    if (share.owner_id !== c.get("userId")) return c.json({ error: "Only the person who shares this can remove its files." }, 403);
    try {
      const key = objectKey(c.req.param("id"), share.id, filePath(share, q.data.path));
      await store().remove(key);
      usage.delete(c.req.param("id"));
      return c.json({ ok: true });
    } catch (e) {
      return e instanceof PathError ? badPath(c, e) : failed(c, "remove", e);
    }
  });

  // The owner removes every stored file of one item.
  files.delete("/:id/files/:share/all", limit("files-delete-all", 30, 60 * 60_000), async (c) => {
    const share = shareOf(c);
    if (share.owner_id !== c.get("userId")) return c.json({ error: "Only the person who shares this can remove its files." }, 403);
    try {
      const removed = await store().removePrefix(sharePrefix(c.req.param("id"), share.id));
      usage.delete(c.req.param("id"));
      return c.json({ ok: true, removed });
    } catch (e) {
      return failed(c, "remove all", e);
    }
  });

  return files;
}

export const files = createFilesRoutes();
