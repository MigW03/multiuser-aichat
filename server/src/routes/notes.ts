import { NOTE_LIMITS } from "@mc/shared";
import { Hono } from "hono";
import { z } from "zod";
import { rateLimit, type AuthVars } from "../auth.ts";
import { dbError } from "../errors.ts";
import { admin } from "../supabase.ts";

// Project notes. Everyone in the project can read them (directly, through RLS); every write comes here and the database
// function checks the person's role: any member adds and edits, the author, the host and admins delete.

export const notes = new Hono<AuthVars>();

const uuid = z.uuid();
// A title is one line of plain text. The text is plain text too; it is only ever shown as text.
const noteBody = z.object({
  title: z.string().trim().min(1).max(NOTE_LIMITS.titleChars),
  body: z.string().max(NOTE_LIMITS.bodyChars),
});
const BAD = { error: "Give the note a title (120 characters at most). The text can be up to 8,000 characters." };

notes.post("/:id/notes", rateLimit("note-write", 60, 60 * 60_000), async (c) => {
  const parsed = noteBody.safeParse(await c.req.json().catch(() => null));
  if (!uuid.safeParse(c.req.param("id")).success || !parsed.success) return c.json(BAD, 400);
  const { data, error } = await admin.rpc("app_note_create", {
    p_user: c.get("userId"),
    p_project: c.req.param("id"),
    p_title: parsed.data.title,
    p_body: parsed.data.body,
    p_ai: false,
  });
  if (error) return dbError(c, error);
  return c.json({ id: data as string });
});

notes.patch("/:id/notes/:noteId", rateLimit("note-write", 600, 60 * 60_000), async (c) => {
  const parsed = noteBody.safeParse(await c.req.json().catch(() => null));
  if (!uuid.safeParse(c.req.param("id")).success || !uuid.safeParse(c.req.param("noteId")).success || !parsed.success) return c.json(BAD, 400);
  // The note must belong to the project in the URL: a member of one project can't reach another's notes through it.
  const { data: row } = await admin.from("project_notes").select("project_id").eq("id", c.req.param("noteId")).maybeSingle();
  if (!row || row.project_id !== c.req.param("id")) return c.json({ error: "That doesn't exist, or you don't have access to it." }, 404);
  const { error } = await admin.rpc("app_note_update", { p_user: c.get("userId"), p_note: c.req.param("noteId"), p_title: parsed.data.title, p_body: parsed.data.body });
  return error ? dbError(c, error) : c.json({ ok: true });
});

notes.delete("/:id/notes/:noteId", async (c) => {
  if (!uuid.safeParse(c.req.param("id")).success || !uuid.safeParse(c.req.param("noteId")).success) return c.json({ error: "Invalid request" }, 400);
  const { data: row } = await admin.from("project_notes").select("project_id").eq("id", c.req.param("noteId")).maybeSingle();
  if (!row || row.project_id !== c.req.param("id")) return c.json({ error: "That doesn't exist, or you don't have access to it." }, 404);
  const { error } = await admin.rpc("app_note_delete", { p_user: c.get("userId"), p_note: c.req.param("noteId") });
  return error ? dbError(c, error) : c.json({ ok: true });
});
