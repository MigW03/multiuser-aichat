import { ASSIGNABLE_ROLES, LIMITS } from "@mc/shared";
import { Hono } from "hono";
import { z } from "zod";
import { rateLimit, type AuthVars } from "../auth.ts";
import { dbError } from "../errors.ts";
import { admin } from "../supabase.ts";
import { createInviteFor, listInvitesFor } from "./invites.ts";

export const projects = new Hono<AuthVars>();

const uuid = z.uuid();
const nameBody = z.object({ name: z.string().trim().min(1).max(LIMITS.projectNameChars) });
const inviteBody = z.object({ email: z.string().trim().min(3).max(254), role: z.enum(ASSIGNABLE_ROLES).default("member") });
const roleBody = z.object({ role: z.enum(ASSIGNABLE_ROLES) });

projects.post("/", rateLimit("project-create", 20, 60 * 60_000), async (c) => {
  const parsed = nameBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Give the project a name (60 characters at most)." }, 400);
  const { data, error } = await admin.rpc("app_create_project", { p_user: c.get("userId"), p_name: parsed.data.name });
  if (error) return dbError(c, error);
  return c.json({ id: data as string });
});

projects.patch("/:id", async (c) => {
  const parsed = nameBody.safeParse(await c.req.json().catch(() => null));
  if (!uuid.safeParse(c.req.param("id")).success || !parsed.success) return c.json({ error: "Invalid request" }, 400);
  const { error } = await admin.rpc("app_rename_project", { p_user: c.get("userId"), p_project: c.req.param("id"), p_name: parsed.data.name });
  return error ? dbError(c, error) : c.json({ ok: true });
});

projects.delete("/:id", async (c) => {
  if (!uuid.safeParse(c.req.param("id")).success) return c.json({ error: "Invalid request" }, 400);
  const { error } = await admin.rpc("app_delete_project", { p_user: c.get("userId"), p_project: c.req.param("id") });
  return error ? dbError(c, error) : c.json({ ok: true });
});

// Which members have saved an AI key (not which key). Shown in the members list.
projects.get("/:id/key-status", async (c) => {
  const id = c.req.param("id");
  if (!uuid.safeParse(id).success) return c.json({ error: "Invalid request" }, 400);
  const { data: role } = await admin.rpc("project_role_of", { p_user: c.get("userId"), p_project: id });
  if (!role) return c.json({ error: "That doesn't exist, or you don't have access to it." }, 404);
  const { data: members } = await admin.from("project_members").select("user_id").eq("project_id", id);
  const ids = (members ?? []).map((m) => m.user_id as string);
  const [{ data: keys }, { data: plans }] = await Promise.all([
    admin.from("user_api_keys").select("user_id").in("user_id", ids),
    admin.from("user_chatgpt_auth").select("user_id").in("user_id", ids),
  ]);
  const withKey = new Set([...(keys ?? []), ...(plans ?? [])].map((k) => k.user_id as string));
  return c.json({ hasKey: Object.fromEntries(ids.map((u) => [u, withKey.has(u)])) });
});

projects.patch("/:id/members/:userId", async (c) => {
  const parsed = roleBody.safeParse(await c.req.json().catch(() => null));
  if (!uuid.safeParse(c.req.param("id")).success || !uuid.safeParse(c.req.param("userId")).success || !parsed.success) return c.json({ error: "Invalid request" }, 400);
  const { error } = await admin.rpc("app_set_member_role", {
    p_user: c.get("userId"),
    p_project: c.req.param("id"),
    p_target: c.req.param("userId"),
    p_role: parsed.data.role,
  });
  return error ? dbError(c, error) : c.json({ ok: true });
});

// Removes a member, or lets the caller leave when the target is themselves.
projects.delete("/:id/members/:userId", async (c) => {
  if (!uuid.safeParse(c.req.param("id")).success || !uuid.safeParse(c.req.param("userId")).success) return c.json({ error: "Invalid request" }, 400);
  const { error } = await admin.rpc("app_remove_member", { p_user: c.get("userId"), p_project: c.req.param("id"), p_target: c.req.param("userId") });
  return error ? dbError(c, error) : c.json({ ok: true });
});

projects.post("/:id/invites", rateLimit("invite", 20, 60 * 60_000), async (c) => {
  const parsed = inviteBody.safeParse(await c.req.json().catch(() => null));
  if (!uuid.safeParse(c.req.param("id")).success || !parsed.success) return c.json({ error: "Enter an email address." }, 400);
  return createInviteFor(c, { project: c.req.param("id"), chat: null, email: parsed.data.email, role: parsed.data.role });
});

projects.get("/:id/invites", async (c) => {
  if (!uuid.safeParse(c.req.param("id")).success) return c.json({ error: "Invalid request" }, 400);
  return listInvitesFor(c, { project: c.req.param("id"), chat: null });
});
