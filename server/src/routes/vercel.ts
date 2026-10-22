import { VERCEL_DEPLOYMENT_PATTERN, VERCEL_ERROR_WINDOWS, VERCEL_LOG_WINDOWS, VERCEL_PROJECT_PATTERN, VERCEL_SECTIONS, VERCEL_TEAM_PATTERN, type VercelSection, type VercelState } from "@mc/shared";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { rateLimit, type AuthVars } from "../auth.ts";
import { dbError } from "../errors.ts";
import { remoteDeps, remoteMcp } from "../mcp-servers.ts";
import { supabaseRemoteStore } from "../mcp-remote-store.ts";
import type { PanelDeps } from "../supabase-panel.ts";
import { vercelLinkStore, type VercelLinkStore } from "../vercel-links.ts";
import { VercelPanel, VercelPanelError, vercelMineOf, vercelRowOf } from "../vercel-panel.ts";

// The Vercel tab of the Files card. A Nido project is linked to one Vercel project by its host or an admin; what is inside
// that Vercel project is read through the asking person's OWN Vercel connection, one fixed read at a time. The link alone
// gives nobody access: Vercel decides what each person's account may see. Only reads: nothing here changes Vercel.

const uuid = z.uuid();
const linkBody = z.object({ teamId: z.string().regex(VERCEL_TEAM_PATTERN), projectId: z.string().regex(VERCEL_PROJECT_PATTERN) });
const sectionQuery = z.object({
  since: z.string().max(10).optional(),
  minutes: z.coerce.number().int().optional(),
  errors: z.enum(["0", "1"]).optional(),
  deployment: z.string().max(60).optional(),
});
const STATUS = { needs_sign_in: 409, no_access: 403, busy: 429, unavailable: 409, window: 400, failed: 502 } as const;

export function createVercelRoutes(deps: { panel: PanelDeps; links: VercelLinkStore; oauthAvailable: () => boolean; /** Tests only: the routes are called many times in a row. */ noRateLimits?: boolean }) {
  const limit = (name: string, max: number, windowMs: number) => (deps.noRateLimits ? createMiddleware(async (_c, next) => next()) : rateLimit(name, max, windowMs));
  const vercel = new Hono<AuthVars>();
  const panel = new VercelPanel(deps.panel);
  const NOT_FOUND = { error: "That doesn't exist, or you don't have access to it." };

  // The state the page needs: the link, how this person's own Vercel connection is doing, and whether they may change the link.
  vercel.get("/:id/vercel", limit("vercel-state", 120, 60_000), async (c) => {
    const id = c.req.param("id");
    if (!uuid.safeParse(id).success) return c.json({ error: "Invalid request" }, 400);
    const userId = c.get("userId");
    try {
      const role = await deps.links.roleOf(userId, id);
      if (!role) return c.json(NOT_FOUND, 404);
      const [link, rows] = await Promise.all([deps.links.get(id), deps.panel.list(userId)]);
      return c.json({ link, mine: vercelMineOf(vercelRowOf(rows), deps.panel.view), canLink: role === "host" || role === "admin", oauthAvailable: deps.oauthAvailable() } satisfies VercelState);
    } catch (e) {
      console.error("[vercel] state failed:", e instanceof Error ? e.message : e);
      return c.json({ error: "Something went wrong" }, 500);
    }
  });

  // The Vercel projects in the asking person's own account, to pick one to link.
  vercel.get("/:id/vercel/projects", limit("vercel-projects", 20, 60_000), async (c) => {
    const id = c.req.param("id");
    if (!uuid.safeParse(id).success) return c.json({ error: "Invalid request" }, 400);
    try {
      const role = await deps.links.roleOf(c.get("userId"), id);
      if (!role) return c.json(NOT_FOUND, 404);
      if (role !== "host" && role !== "admin") return c.json({ error: "You don't have permission to do that." }, 403);
      return c.json({ projects: await panel.projects(c.get("userId")) });
    } catch (e) {
      return panelFailure(c, e);
    }
  });

  vercel.put("/:id/vercel", limit("vercel-link", 20, 60 * 60_000), async (c) => {
    const id = c.req.param("id");
    const parsed = linkBody.safeParse(await c.req.json().catch(() => null));
    if (!uuid.safeParse(id).success || !parsed.success) return c.json({ error: "Invalid request" }, 400);
    const userId = c.get("userId");
    try {
      const role = await deps.links.roleOf(userId, id);
      if (!role) return c.json(NOT_FOUND, 404);
      if (role !== "host" && role !== "admin") return c.json({ error: "You don't have permission to do that." }, 403);
      // The project must be one in the person's own Vercel account: its name and team come from there, never from the page.
      const picked = (await panel.projects(userId)).find((p) => p.projectId === parsed.data.projectId && p.teamId === parsed.data.teamId);
      if (!picked) return c.json({ error: "That project is not in your Vercel account." }, 404);
      const failed = await deps.links.set(userId, id, { teamId: picked.teamId, teamSlug: picked.teamSlug, projectId: picked.projectId, name: picked.name });
      if (failed) return dbError(c, { message: failed.error });
      return c.json({ link: await deps.links.get(id) });
    } catch (e) {
      return panelFailure(c, e);
    }
  });

  vercel.delete("/:id/vercel", limit("vercel-link", 20, 60 * 60_000), async (c) => {
    const id = c.req.param("id");
    if (!uuid.safeParse(id).success) return c.json({ error: "Invalid request" }, 400);
    try {
      const failed = await deps.links.remove(c.get("userId"), id);
      return failed ? dbError(c, { message: failed.error }) : c.json({ ok: true });
    } catch (e) {
      console.error("[vercel] unlink failed:", e instanceof Error ? e.message : e);
      return c.json({ error: "Something went wrong" }, 500);
    }
  });

  // One section of the linked project, read through the asking person's own Vercel connection.
  vercel.get("/:id/vercel/data/:section", limit("vercel-data", 60, 60_000), async (c) => {
    const id = c.req.param("id");
    const section = c.req.param("section");
    const q = sectionQuery.safeParse(c.req.query());
    if (!uuid.safeParse(id).success || !(VERCEL_SECTIONS as readonly string[]).includes(section) || !q.success) return c.json({ error: "Invalid request" }, 400);
    const minutes = q.data.minutes ?? 30;
    const since = q.data.since ?? "24h";
    if (!(VERCEL_LOG_WINDOWS as readonly number[]).includes(minutes) || !(VERCEL_ERROR_WINDOWS as readonly string[]).includes(since)) return c.json({ error: "Invalid request" }, 400);
    if (q.data.deployment !== undefined && !VERCEL_DEPLOYMENT_PATTERN.test(q.data.deployment)) return c.json({ error: "Invalid request" }, 400);
    try {
      if (!(await deps.links.roleOf(c.get("userId"), id))) return c.json(NOT_FOUND, 404);
      const link = await deps.links.get(id);
      if (!link) return c.json({ error: "No Vercel project is linked.", code: "not_linked" }, 404);
      const data = await panel.section(c.get("userId"), link, section as VercelSection, { minutes, since, errorsOnly: q.data.errors === "1", ...(q.data.deployment ? { deployment: q.data.deployment } : {}) });
      return c.json({ data });
    } catch (e) {
      return panelFailure(c, e);
    }
  });

  return { vercel };
}

function panelFailure(c: import("hono").Context, e: unknown) {
  if (e instanceof VercelPanelError) return c.json({ error: e.message, code: e.code }, STATUS[e.code]);
  console.error("[vercel] failed:", e instanceof Error ? e.message : e);
  return c.json({ error: "Something went wrong" }, 500);
}

export const { vercel } = createVercelRoutes({
  panel: { list: (u) => supabaseRemoteStore.list(u), view: (r) => remoteMcp.view(r), call: (u, req) => remoteMcp.call(u, req) },
  links: vercelLinkStore,
  oauthAvailable: () => !!remoteDeps.serverUrl,
});
