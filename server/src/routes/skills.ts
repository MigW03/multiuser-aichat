import { cleanBody, cleanLine, SKILL_LIMITS, skillProblem, type PluginPreview } from "@mc/shared";
import { Hono } from "hono";
import { z } from "zod";
import { rateLimit, type AuthVars } from "../auth.ts";
import { dbError } from "../errors.ts";
import { getSkill, isMember, listSkills, pluginUpdateInfo } from "../skills.ts";
import { PluginFileError, readPluginFile } from "../skills-zip.ts";
import { admin } from "../supabase.ts";

// Skills and plugins. Every route is about the signed-in person's own skills, or, with ?project=<id>, a project's they are
// in. Reads are checked here; every write goes through a database function (service role only) that checks the person's
// role and the limits again. See supabase/migrations/0026_skills.sql.

export const skills = new Hono<AuthVars>();

const uuid = z.uuid();
const BAD = { error: "That isn't valid." };
const NOT_FOUND = { error: "That doesn't exist, or you don't have access to it." };

/** ?project=<id>: a project's skills. Not given: the person's own. `false` when it is not an id. */
const scopeOf = (c: { req: { query: (k: string) => string | undefined } }): string | null | false => {
  const p = c.req.query("project");
  if (p === undefined || p === "") return null;
  return uuid.safeParse(p).success ? p : false;
};

const fields = z.object({
  name: z.string().max(80),
  description: z.string().max(2000),
  body: z.string().max(SKILL_LIMITS.bodyChars * 4),
  auto_use: z.boolean(),
});
const toggle = z.object({ enabled: z.boolean().optional(), auto_use: z.boolean().optional() }).refine((v) => v.enabled !== undefined || v.auto_use !== undefined);

/** The fields as they are saved, or the reason they can't be. */
function clean(input: z.infer<typeof fields>): { ok: true; value: { name: string; description: string; body: string; auto_use: boolean } } | { ok: false; error: string } {
  const value = { name: input.name.trim(), description: cleanLine(input.description, 1000), body: cleanBody(input.body), auto_use: input.auto_use };
  const problem = skillProblem(value);
  return problem ? { ok: false, error: problem } : { ok: true, value };
}

skills.get("/", rateLimit("skills-read", 600, 60 * 60_000), async (c) => {
  const project = scopeOf(c);
  if (project === false) return c.json(BAD, 400);
  try {
    return c.json(await listSkills(admin, c.get("userId"), project));
  } catch (e) {
    console.error("[skills]", e instanceof Error ? e.message : e);
    return c.json({ error: "Something went wrong" }, 500);
  }
});

// ---- plugins (before "/:id", so "plugins" is never read as an id)

const FILE_BAD = { error: "Choose a .zip plugin file." };

async function readUpload(c: { req: { arrayBuffer: () => Promise<ArrayBuffer> } }): Promise<{ ok: true; data: Uint8Array } | { ok: false }> {
  const buf = await c.req.arrayBuffer().catch(() => null);
  return buf && buf.byteLength > 0 ? { ok: true, data: new Uint8Array(buf) } : { ok: false };
}

/** Shows what is in a plugin file. Nothing is saved. */
skills.post("/plugins/preview", rateLimit("plugin-preview", 60, 60 * 60_000), async (c) => {
  const project = scopeOf(c);
  if (project === false) return c.json(BAD, 400);
  if (project && !(await isMember(admin, c.get("userId"), project))) return c.json(NOT_FOUND, 404);
  const up = await readUpload(c);
  if (!up.ok) return c.json(FILE_BAD, 400);
  try {
    const read = readPluginFile(up.data);
    const preview: PluginPreview = {
      ...read.manifest,
      skills: read.skills.map((s) => ({ name: s.name, description: s.description, body_chars: s.body.length, problem: s.problem })),
      left_out: read.left_out,
      update: await pluginUpdateInfo(admin, c.get("userId"), project, read),
    };
    return c.json(preview);
  } catch (e) {
    if (e instanceof PluginFileError) return c.json({ error: e.message }, 400);
    console.error("[skills] preview:", e instanceof Error ? e.message : e);
    return c.json({ error: "That file could not be read." }, 400);
  }
});

/** Installs a plugin (or updates the one with the same name): ?skills=a,b names the ones to install. */
skills.post("/plugins", rateLimit("plugin-install", 30, 60 * 60_000), async (c) => {
  const project = scopeOf(c);
  if (project === false) return c.json(BAD, 400);
  const up = await readUpload(c);
  if (!up.ok) return c.json(FILE_BAD, 400);
  const chosen = new Set((c.req.query("skills") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  try {
    const read = readPluginFile(up.data);
    const picked = read.skills.filter((s) => chosen.has(s.name));
    if (picked.length === 0) return c.json({ error: "Pick at least one skill to install." }, 400);
    const bad = picked.find((s) => s.problem);
    if (bad) return c.json({ error: `${bad.name}: ${bad.problem}` }, 400);
    // The manifest is read again here, from the same bytes: what is saved is what the preview showed.
    const { data, error } = await admin.rpc("app_plugin_install", {
      p_user: c.get("userId"),
      p_project: project,
      p_plugin: { ...read.manifest, skills: picked.map((s) => ({ name: s.name, description: s.description, body: s.body })) },
    });
    if (error) return dbError(c, error);
    return c.json({ id: data as string });
  } catch (e) {
    if (e instanceof PluginFileError) return c.json({ error: e.message }, 400);
    console.error("[skills] install:", e instanceof Error ? e.message : e);
    return c.json({ error: "That file could not be read." }, 400);
  }
});

skills.patch("/plugins/:id", rateLimit("skills-write", 600, 60 * 60_000), async (c) => {
  const project = scopeOf(c);
  const parsed = z.object({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (project === false || !uuid.safeParse(c.req.param("id")).success || !parsed.success) return c.json(BAD, 400);
  const { error } = await admin.rpc("app_plugin_set", { p_user: c.get("userId"), p_project: project, p_id: c.req.param("id"), p_enabled: parsed.data.enabled });
  return error ? dbError(c, error) : c.json({ ok: true });
});

skills.delete("/plugins/:id", rateLimit("skills-write", 600, 60 * 60_000), async (c) => {
  const project = scopeOf(c);
  if (project === false || !uuid.safeParse(c.req.param("id")).success) return c.json(BAD, 400);
  const { error } = await admin.rpc("app_plugin_delete", { p_user: c.get("userId"), p_project: project, p_id: c.req.param("id") });
  return error ? dbError(c, error) : c.json({ ok: true });
});

// ---- single skills

skills.post("/", rateLimit("skills-write", 600, 60 * 60_000), async (c) => {
  const project = scopeOf(c);
  const parsed = fields.safeParse(await c.req.json().catch(() => null));
  if (project === false || !parsed.success) return c.json(BAD, 400);
  const v = clean(parsed.data);
  if (!v.ok) return c.json({ error: v.error }, 400);
  const { data, error } = await admin.rpc("app_skill_save", { p_user: c.get("userId"), p_project: project, p_id: null, p_name: v.value.name, p_description: v.value.description, p_body: v.value.body, p_auto_use: v.value.auto_use });
  return error ? dbError(c, error) : c.json({ id: data as string });
});

skills.get("/:id", rateLimit("skills-read", 600, 60 * 60_000), async (c) => {
  const project = scopeOf(c);
  if (project === false || !uuid.safeParse(c.req.param("id")).success) return c.json(BAD, 400);
  const skill = await getSkill(admin, c.get("userId"), project, c.req.param("id"));
  return skill ? c.json(skill) : c.json(NOT_FOUND, 404);
});

skills.put("/:id", rateLimit("skills-write", 600, 60 * 60_000), async (c) => {
  const project = scopeOf(c);
  const parsed = fields.safeParse(await c.req.json().catch(() => null));
  if (project === false || !uuid.safeParse(c.req.param("id")).success || !parsed.success) return c.json(BAD, 400);
  const v = clean(parsed.data);
  if (!v.ok) return c.json({ error: v.error }, 400);
  const { error } = await admin.rpc("app_skill_save", { p_user: c.get("userId"), p_project: project, p_id: c.req.param("id"), p_name: v.value.name, p_description: v.value.description, p_body: v.value.body, p_auto_use: v.value.auto_use });
  return error ? dbError(c, error) : c.json({ ok: true });
});

/** Switch a skill on or off, or its "AI may use on its own". */
skills.patch("/:id", rateLimit("skills-write", 600, 60 * 60_000), async (c) => {
  const project = scopeOf(c);
  const parsed = toggle.safeParse(await c.req.json().catch(() => null));
  if (project === false || !uuid.safeParse(c.req.param("id")).success || !parsed.success) return c.json(BAD, 400);
  const { error } = await admin.rpc("app_skill_set", { p_user: c.get("userId"), p_project: project, p_id: c.req.param("id"), p_enabled: parsed.data.enabled ?? null, p_auto_use: parsed.data.auto_use ?? null });
  return error ? dbError(c, error) : c.json({ ok: true });
});

skills.delete("/:id", rateLimit("skills-write", 600, 60 * 60_000), async (c) => {
  const project = scopeOf(c);
  if (project === false || !uuid.safeParse(c.req.param("id")).success) return c.json(BAD, 400);
  const { error } = await admin.rpc("app_skill_delete", { p_user: c.get("userId"), p_project: project, p_id: c.req.param("id") });
  return error ? dbError(c, error) : c.json({ ok: true });
});
