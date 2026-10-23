import { DESIGN_LIMITS, emptyDesign, projectDesignPath, projectDesignSlug } from "@mc/shared";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { rateLimit, type AuthVars } from "../auth.ts";
import { designList, designSaved } from "../design-events.ts";
import { createDesigns, DesignError, type DesignErrorCode, type Designs } from "../project-designs.ts";
import { StorageOffError } from "../r2.ts";

// A project's designs (project-designs.ts): every member lists, opens, makes, saves and restores them; the maker, the host
// and admins delete. A save names the version it was made from. Saved designs are announced on the project's channel so
// open canvases reload.

const uuid = z.uuid();
const slugParam = z.string().max(DESIGN_LIMITS.nameChars).refine((s) => projectDesignSlug(projectDesignPath(s)) !== null);
const version = z.number().int().min(1).max(1_000_000_000);
const createBody = z.object({
  name: z.string().trim().min(1).max(DESIGN_LIMITS.nameChars),
  board: z.enum(["desktop", "phone"]).optional(),
  /** A copy of an older design file from a shared folder ("Move to project"). */
  content: z.string().max(DESIGN_LIMITS.chars).optional(),
});
const saveBody = z.object({ content: z.string().max(DESIGN_LIMITS.chars), baseVersion: version });
const restoreBody = z.object({ version, baseVersion: version });

const STATUS: Record<DesignErrorCode, ContentfulStatusCode> = {
  not_found: 404,
  forbidden: 403,
  stale: 409,
  exists: 409,
  full: 409,
  invalid: 400,
  too_large: 413,
  unsafe: 422,
  secrets: 422,
  no_match: 422,
  ambiguous: 422,
};

export function failed(c: Context, e: unknown) {
  if (e instanceof DesignError) return c.json({ error: e.message, code: e.code }, STATUS[e.code]);
  if (e instanceof StorageOffError) return c.json({ error: "Design storage isn't set up on this server yet.", code: "storage_off" }, 503);
  // Object store errors can name the endpoint or bucket, so only their kind is logged; database errors are ours.
  console.error("[designs]", e instanceof Error ? (e.message.startsWith("database:") ? e.message : e.name) : "unknown error");
  return c.json({ error: "The designs could not be reached. Try again in a moment." }, 502);
}

export function createDesignRoutes(deps: { designs?: Designs; noRateLimits?: boolean; announce?: boolean } = {}) {
  const designs = deps.designs ?? createDesigns();
  const announce = deps.announce ?? true;
  const limit = (name: string, max: number, windowMs: number) => (deps.noRateLimits ? createMiddleware(async (_c, next) => next()) : rateLimit(name, max, windowMs));
  const routes = new Hono<AuthVars>();

  const validId = createMiddleware<AuthVars>(async (c, next) => (uuid.safeParse(c.req.param("id")).success ? next() : c.json({ error: "Invalid request" }, 400)));
  routes.use("/:id/designs", validId);
  routes.use("/:id/designs/*", validId);

  /** The design in the URL. A slug that isn't valid names no design (a name with ":" never matches one). */
  const pathOf = (c: Context) => {
    const slug = c.req.param("slug") ?? "";
    return slugParam.safeParse(slug).success ? projectDesignPath(slug) : ":";
  };

  routes.get("/:id/designs", limit("design-read", 300, 60_000), async (c) => {
    try {
      return c.json({ designs: await designs.list(c.get("userId"), c.req.param("id")) });
    } catch (e) {
      return failed(c, e);
    }
  });

  routes.post("/:id/designs", limit("design-create", 60, 60 * 60_000), async (c) => {
    const body = createBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Give the design a name (60 characters at most)." }, 400);
    const userId = c.get("userId");
    const projectId = c.req.param("id");
    try {
      const r = await designs.create(userId, projectId, body.data.name, body.data.content ?? emptyDesign(body.data.board ?? "desktop"), { unique: true });
      if (announce) void designList(projectId, { by: userId });
      return c.json(r);
    } catch (e) {
      return failed(c, e);
    }
  });

  routes.get("/:id/designs/:slug", limit("design-read", 300, 60_000), async (c) => {
    try {
      return c.json(await designs.read(c.get("userId"), c.req.param("id"), pathOf(c)));
    } catch (e) {
      return failed(c, e);
    }
  });

  routes.put("/:id/designs/:slug", limit("design-save", 120, 60_000), async (c) => {
    const body = saveBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid request" }, 400);
    const userId = c.get("userId");
    const projectId = c.req.param("id");
    try {
      const r = await designs.save(userId, projectId, pathOf(c), body.data.content, body.data.baseVersion);
      if (announce) void designSaved(projectId, { path: r.path, version: r.version, by: userId });
      return c.json(r);
    } catch (e) {
      return failed(c, e);
    }
  });

  routes.delete("/:id/designs/:slug", limit("design-delete", 60, 60 * 60_000), async (c) => {
    const userId = c.get("userId");
    const projectId = c.req.param("id");
    try {
      const r = await designs.remove(userId, projectId, pathOf(c));
      if (announce) void designList(projectId, { by: userId });
      return c.json(r);
    } catch (e) {
      return failed(c, e);
    }
  });

  routes.get("/:id/designs/:slug/versions", limit("design-read", 300, 60_000), async (c) => {
    try {
      return c.json(await designs.versions(c.get("userId"), c.req.param("id"), pathOf(c)));
    } catch (e) {
      return failed(c, e);
    }
  });

  routes.post("/:id/designs/:slug/restore", limit("design-save", 120, 60_000), async (c) => {
    const body = restoreBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid request" }, 400);
    const userId = c.get("userId");
    const projectId = c.req.param("id");
    try {
      const r = await designs.restore(userId, projectId, pathOf(c), body.data.version, body.data.baseVersion);
      if (announce) void designSaved(projectId, { path: r.path, version: r.version, by: userId });
      return c.json(r);
    } catch (e) {
      return failed(c, e);
    }
  });

  return routes;
}
