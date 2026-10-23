import { ASSIGNABLE_ROLES, LIMITS } from "@mc/shared";
import { Hono } from "hono";
import { z } from "zod";
import { rateLimit, type AuthVars } from "../auth.ts";
import { dbError } from "../errors.ts";
import { imagePathsOfChats, removeImageFiles } from "../images.ts";
import { dropProjectFiles } from "../stored-files.ts";
import { admin } from "../supabase.ts";
import { createInviteFor, listInvitesFor } from "./invites.ts";

export const projects = new Hono<AuthVars>();

const uuid = z.uuid();
const nameBody = z.object({ name: z.string().trim().min(1).max(LIMITS.projectNameChars) });
const orderBody = z.object({ ids: z.array(uuid).max(200) });
const inviteBody = z.object({ email: z.string().trim().min(3).max(254), role: z.enum(ASSIGNABLE_ROLES).default("member") });
const roleBody = z.object({ role: z.enum(ASSIGNABLE_ROLES) });

projects.post("/", rateLimit("project-create", 20, 60 * 60_000), async (c) => {
  const parsed = nameBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Give the project a name (60 characters at most)." }, 400);
  const { data, error } = await admin.rpc("app_create_project", { p_user: c.get("userId"), p_name: parsed.data.name });
  if (error) return dbError(c, error);
  return c.json({ id: data as string });
});

// Saves the caller's own order of their projects list. Other members' order is never touched.
projects.put("/order", async (c) => {
  const parsed = orderBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
  const { error } = await admin.rpc("app_reorder_projects", { p_user: c.get("userId"), p_ids: parsed.data.ids });
  return error ? dbError(c, error) : c.json({ ok: true });
});

projects.patch("/:id", async (c) => {
  const parsed = nameBody.safeParse(await c.req.json().catch(() => null));
  if (!uuid.safeParse(c.req.param("id")).success || !parsed.success) return c.json({ error: "Invalid request" }, 400);
  const { error } = await admin.rpc("app_rename_project", { p_user: c.get("userId"), p_project: c.req.param("id"), p_name: parsed.data.name });
  return error ? dbError(c, error) : c.json({ ok: true });
});

projects.delete("/:id", async (c) => {
  if (!uuid.safeParse(c.req.param("id")).success) return c.json({ error: "Invalid request" }, 400);
  // The pictures' files go from storage once the database accepts the delete (it checks that the caller is the host).
  const { data: chatRows } = await admin.from("chats").select("id").eq("project_id", c.req.param("id"));
  const paths = await imagePathsOfChats((chatRows ?? []).map((r) => r.id as string));
  const { error } = await admin.rpc("app_delete_project", { p_user: c.get("userId"), p_project: c.req.param("id") });
  if (error) return dbError(c, error);
  void removeImageFiles(paths);
  void dropProjectFiles(c.req.param("id"));
  return c.json({ ok: true });
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
