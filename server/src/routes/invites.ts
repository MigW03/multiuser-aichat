import { LIMITS, type AcceptInviteResponse, type InvitePreview, type PendingInvite } from "@mc/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { optionalUserId, rateLimit, type AuthVars } from "../auth.ts";
import { env } from "../env.ts";
import { dbError } from "../errors.ts";
import { sendInviteEmail } from "../mail.ts";
import { admin } from "../supabase.ts";

const uuid = z.uuid();
const token = z.string().regex(/^[0-9a-f]{64}$/);

export const inviteLink = (t: string) => `${env.appUrl}/#/join/${t}`;

type Scope = { project: string | null; chat: string | null };

export async function createInviteFor(c: Context<AuthVars>, scope: Scope & { email: string; role: string }) {
  const userId = c.get("userId");
  const { data, error } = await admin.rpc("app_create_invite", {
    p_user: userId,
    p_project: scope.project,
    p_chat: scope.chat,
    p_email: scope.email,
    p_role: scope.role,
  });
  if (error) return dbError(c, error);
  const row = (data as { invite_id: string; invite_token: string; invite_expires_at: string }[])[0]!;
  const link = inviteLink(row.invite_token);

  let what = "a chat";
  if (scope.project) what = ((await admin.from("projects").select("name").eq("id", scope.project).single()).data?.name as string | undefined) ?? "a project";
  else if (scope.chat) what = ((await admin.from("chats").select("title").eq("id", scope.chat).single()).data?.title as string | undefined) ?? "a chat";
  const inviter = ((await admin.from("profiles").select("display_name").eq("id", userId).single()).data?.display_name as string | undefined) ?? "Someone";
  const emailed = await sendInviteEmail({ to: scope.email.trim().toLowerCase(), inviter, what, link, days: LIMITS.inviteDays });
  return c.json({ id: row.invite_id, link, expires_at: row.invite_expires_at, emailed });
}

export async function listInvitesFor(c: Context<AuthVars>, scope: Scope) {
  const { data, error } = await admin.rpc("app_list_invites", { p_user: c.get("userId"), p_project: scope.project, p_chat: scope.chat });
  if (error) return dbError(c, error);
  const invites = ((data ?? []) as { invite_id: string; email: string; role: PendingInvite["role"]; token: string; created_at: string; expires_at: string }[]).map((i) => ({
    id: i.invite_id,
    email: i.email,
    role: i.role,
    link: inviteLink(i.token),
    created_at: i.created_at,
    expires_at: i.expires_at,
  }));
  return c.json({ invites });
}

/** "dan@example.com" -> "d•••@example.com" */
const maskEmail = (email: string) => `${email.slice(0, 1)}•••${email.slice(email.indexOf("@"))}`;

// ---- Routes under /api/invites. The preview works signed out; everything else needs a signed-in user.
export const publicInvites = new Hono<AuthVars>();

// The join page calls this before anyone has an account. The token is 256 random bits, so it works like a password.
publicInvites.get("/:token", rateLimit("invite-preview", 30, 60_000, "ip"), async (c) => {
  if (!token.safeParse(c.req.param("token")).success) return c.json(emptyPreview("invalid"));
  const { data, error } = await admin.rpc("app_preview_invite", { p_token: c.req.param("token") });
  if (error) return dbError(c, error);
  const row = (data as { status: InvitePreview["status"]; scope: InvitePreview["scope"]; name: string | null; inviter_name: string | null; role: InvitePreview["role"]; email: string | null; members: InvitePreview["members"] }[])[0];
  if (!row || row.status === "invalid") return c.json(emptyPreview("invalid"));

  // Signed in as someone else: don't hand them the address, only a masked hint.
  const userId = await optionalUserId(c);
  let showFull = true;
  if (userId && row.email) {
    const { data: me } = await admin.from("profiles").select("email").eq("id", userId).single();
    showFull = me?.email === row.email;
  }
  const preview: InvitePreview = {
    status: row.status,
    scope: row.scope,
    name: row.name,
    inviter: row.inviter_name,
    role: row.role,
    email: row.email ? (showFull ? row.email : maskEmail(row.email)) : null,
    emailMasked: !showFull,
    members: row.members ?? [],
  };
  return c.json(preview);
});

function emptyPreview(status: InvitePreview["status"]): InvitePreview {
  return { status, scope: null, name: null, inviter: null, role: null, email: null, emailMasked: false, members: [] };
}

export const invites = new Hono<AuthVars>();

invites.post("/:token/accept", rateLimit("invite-accept", 20, 60_000), async (c) => {
  if (!token.safeParse(c.req.param("token")).success) return c.json({ error: "This invite isn't valid." }, 404);
  const { data, error } = await admin.rpc("app_accept_invite", { p_user: c.get("userId"), p_token: c.req.param("token") });
  if (error) return dbError(c, error);
  const row = (data as { out_project_id: string | null; out_chat_id: string | null }[])[0]!;
  return c.json({ projectId: row.out_project_id, chatId: row.out_chat_id } satisfies AcceptInviteResponse);
});

invites.delete("/:id", async (c) => {
  if (!uuid.safeParse(c.req.param("id")).success) return c.json({ error: "Invalid request" }, 400);
  const { error } = await admin.rpc("app_revoke_invite", { p_user: c.get("userId"), p_invite: c.req.param("id") });
  return error ? dbError(c, error) : c.json({ ok: true });
});
