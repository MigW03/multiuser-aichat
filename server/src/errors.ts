import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// The app_* database functions raise short codes. This maps each to an HTTP status and a message safe to show.
const KNOWN: Record<string, [ContentfulStatusCode, string]> = {
  not_found: [404, "That doesn't exist, or you don't have access to it."],
  forbidden: [403, "You don't have permission to do that."],
  invalid_name: [400, "That name isn't valid."],
  invalid_email: [400, "That email address doesn't look right."],
  invalid_role: [400, "That role isn't valid."],
  notes_full: [409, "This project has 200 notes already. Delete one first."],
  designs_full: [409, "This project has 200 designs already. Delete one first."],
  design_exists: [409, "A design with that name already exists. Pick another name."],
  stale: [409, "The design changed since it was opened. It was reloaded."],
  invalid_scope: [400, "Invalid request."],
  already_member: [409, "That person is already in here."],
  project_full: [409, "This project is full. A project holds up to 10 people, pending invites included."],
  chat_full: [409, "This chat is full. A chat holds up to 10 people, pending invites included."],
  host_cannot_leave: [409, "The host can't be removed or leave the project."],
  invalid_invite: [404, "This invite isn't valid."],
  invite_expired: [410, "This invite has expired."],
  invite_used: [410, "This invite was already used."],
  wrong_account: [403, "This invite was sent to a different email address."],
  email_not_confirmed: [403, "Confirm your email address first, then open the invite link again."],
};

/** Responds with the right error for a Supabase RPC failure; unknown errors are logged and shown generically. */
export function dbError(c: Context, error: { message?: string } | null | undefined) {
  const code = (error?.message ?? "").trim();
  const known = KNOWN[code];
  if (known) return c.json({ error: known[1], code }, known[0]);
  console.error("[db]", error?.message ?? error);
  return c.json({ error: "Something went wrong" }, 500);
}
