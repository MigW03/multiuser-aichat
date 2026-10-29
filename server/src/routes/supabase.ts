import { SUPABASE_LOG_WINDOWS, SUPABASE_REF_PATTERN, SUPABASE_SECTIONS, type SupabaseState } from "@mc/shared";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { rateLimit, type AuthVars } from "../auth.ts";
import { dbError } from "../errors.ts";
import { supabaseLinkStore, type LinkStore } from "../supabase-links.ts";
import { remoteDeps, remoteMcp } from "../mcp-servers.ts";
import { supabaseRemoteStore } from "../mcp-remote-store.ts";
import { isLogSource, mineOf, PanelError, SupabasePanel, supabaseRowOf, type PanelDeps } from "../supabase-panel.ts";

// The Supabase tab of the Files card. A Nido project is linked to one Supabase project by its host or an admin; what is
// inside that Supabase project is read through the asking person's OWN Supabase connection, one fixed read at a time.
// The link alone gives nobody access: Supabase decides what each person's account may see.

const uuid = z.uuid();
const linkBody = z.object({ ref: z.string().regex(SUPABASE_REF_PATTERN) });
const sectionQuery = z.object({
  source: z.string().max(40).optional(),
  minutes: z.coerce.number().int().optional(),
  errors: z.enum(["0", "1"]).optional(),
});
const STATUS = { needs_sign_in: 409, no_access: 403, busy: 429, unavailable: 409, failed: 502 } as const;

export function createSupabaseRoutes(deps: { panel: PanelDeps; links: LinkStore; oauthAvailable: () => boolean; /** Tests only: the routes are called many times in a row. */ noRateLimits?: boolean }) {
  const limit = (name: string, max: number, windowMs: number) => (deps.noRateLimits ? createMiddleware(async (_c, next) => next()) : rateLimit(name, max, windowMs));
  const supabase = new Hono<AuthVars>();
  const panel = new SupabasePanel(deps.panel);

  const roleOf = (c: { get: (k: "userId") => string }, projectId: string) => deps.links.roleOf(c.get("userId"), projectId);
  const NOT_FOUND = { error: "That doesn't exist, or you don't have access to it." };

  // The state the page needs: the link, how this person's own Supabase connection is doing, and whether they may change the link.
  supabase.get("/:id/supabase", limit("supabase-state", 120, 60_000), async (c) => {
    const id = c.req.param("id");
    if (!uuid.safeParse(id).success) return c.json({ error: "Invalid request" }, 400);
    const userId = c.get("userId");
    try {
      const role = await deps.links.roleOf(userId, id);
      if (!role) return c.json(NOT_FOUND, 404);
      const [link, rows] = await Promise.all([deps.links.get(id), deps.panel.list(userId)]);
      return c.json({ link, mine: mineOf(supabaseRowOf(rows), deps.panel.view), canLink: role === "host" || role === "admin", oauthAvailable: deps.oauthAvailable() } satisfies SupabaseState);
    } catch (e) {
      console.error("[supabase] state failed:", e instanceof Error ? e.message : e);
      return c.json({ error: "Something went wrong" }, 500);
    }
  });

  // The Supabase projects in the asking person's own account, to pick one to link.
  supabase.get("/:id/supabase/projects", limit("supabase-projects", 20, 60_000), async (c) => {
    const id = c.req.param("id");
    if (!uuid.safeParse(id).success) return c.json({ error: "Invalid request" }, 400);
    try {
      const role = await roleOf(c, id);
      if (!role) return c.json(NOT_FOUND, 404);
      if (role !== "host" && role !== "admin") return c.json({ error: "You don't have permission to do that." }, 403);
      return c.json({ projects: await panel.projects(c.get("userId")) });
    } catch (e) {
      return panelFailure(c, e);
    }
  });

  supabase.put("/:id/supabase", limit("supabase-link", 20, 60 * 60_000), async (c) => {
    const id = c.req.param("id");
    const parsed = linkBody.safeParse(await c.req.json().catch(() => null));
    if (!uuid.safeParse(id).success || !parsed.success) return c.json({ error: "Invalid request" }, 400);
    const userId = c.get("userId");
    try {
      const role = await deps.links.roleOf(userId, id);
      if (!role) return c.json(NOT_FOUND, 404);
      if (role !== "host" && role !== "admin") return c.json({ error: "You don't have permission to do that." }, 403);
      // The project must be one in the person's own Supabase account: its name and region come from there, never from the page.
      const picked = (await panel.projects(userId)).find((p) => p.ref === parsed.data.ref);
      if (!picked) return c.json({ error: "That project is not in your Supabase account." }, 404);
      const failed = await deps.links.set(userId, id, { ref: picked.ref, name: picked.name, region: picked.region });
      if (failed) return dbError(c, { message: failed.error });
      return c.json({ link: await deps.links.get(id) });
    } catch (e) {
      return panelFailure(c, e);
    }
  });

  supabase.delete("/:id/supabase", limit("supabase-link", 20, 60 * 60_000), async (c) => {
    const id = c.req.param("id");
    if (!uuid.safeParse(id).success) return c.json({ error: "Invalid request" }, 400);
    try {
      const failed = await deps.links.remove(c.get("userId"), id);
      return failed ? dbError(c, { message: failed.error }) : c.json({ ok: true });
    } catch (e) {
      console.error("[supabase] unlink failed:", e instanceof Error ? e.message : e);
      return c.json({ error: "Something went wrong" }, 500);
    }
  });

  // One section of the linked project, read through the asking person's own Supabase connection.
  supabase.get("/:id/supabase/data/:section", limit("supabase-data", 60, 60_000), async (c) => {
    const id = c.req.param("id");
    const section = c.req.param("section");
    const q = sectionQuery.safeParse(c.req.query());
    if (!uuid.safeParse(id).success || !(SUPABASE_SECTIONS as readonly string[]).includes(section) || !q.success) return c.json({ error: "Invalid request" }, 400);
    const source = q.data.source ?? "postgres_logs";
    const minutes = q.data.minutes ?? 60;
    if (!isLogSource(source) || !(SUPABASE_LOG_WINDOWS as readonly number[]).includes(minutes)) return c.json({ error: "Invalid request" }, 400);
    try {
      if (!(await roleOf(c, id))) return c.json(NOT_FOUND, 404);
      const link = await deps.links.get(id);
      if (!link) return c.json({ error: "No Supabase project is linked.", code: "not_linked" }, 404);
      const data = await panel.section(c.get("userId"), link.ref, section as (typeof SUPABASE_SECTIONS)[number], { source, minutes, errorsOnly: q.data.errors === "1" });
      return c.json({ data });
    } catch (e) {
      return panelFailure(c, e);
    }
  });

  return { supabase };
}

function panelFailure(c: import("hono").Context, e: unknown) {
  if (e instanceof PanelError) return c.json({ error: e.message, code: e.code }, STATUS[e.code]);
  console.error("[supabase] failed:", e instanceof Error ? e.message : e);
  return c.json({ error: "Something went wrong" }, 500);
}

export const { supabase } = createSupabaseRoutes({
  panel: { list: (u) => supabaseRemoteStore.list(u), view: (r) => remoteMcp.view(r), call: (u, req) => remoteMcp.call(u, req) },
  links: supabaseLinkStore,
  oauthAvailable: () => !!remoteDeps.serverUrl,
});
