import { NOTE_LIMITS, type ProjectNote, type ProjectSummary } from "@mc/shared";
import { FileText, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { notifyChanged, useApp, useLive } from "../data.tsx";
import { listTime } from "../lib/time.ts";
import { supabase } from "../supabase.ts";
import { ConfirmDialog } from "./Dialogs.tsx";
import { AiAvatar, Avatar, Button, ErrorLine, ICON_SM, IconButton, Menu, Spinner, STROKE } from "./kit.tsx";

// Notes sit under the files card in the right column, as the approved boards draw them ("Hi-fi · light", "Notes states"):
// short notes shared with everyone in the project. Anyone in the project can add and edit; the note's author, the host and
// admins can delete. Clicking a note opens it to READ (the whole text, nothing editable); Edit is a separate step. A note the AI wrote (someone said "take a note", or Save as note under an answer) shows the AI's
// avatar when the AI wrote it, and the person's avatar otherwise ("AI note options", option A). The list is live.

type NoteRow = ProjectNote & { author_name: string };
type Filter = "all" | "ai" | "people";

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : "Something went wrong. Try again.");

function useProjectNotes(projectId: string) {
  return useLive<NoteRow[]>(async () => {
    const { data, error } = await supabase
      .from("project_notes")
      .select("id, project_id, title, body, created_by, by_ai, created_at, updated_at, updated_by, author:profiles!created_by(display_name)")
      .eq("project_id", projectId)
      .order("updated_at", { ascending: false });
    if (error) throw new Error("Could not load the notes.");
    return ((data ?? []) as unknown as (ProjectNote & { author: { display_name: string } | null })[]).map(({ author, ...n }) => ({ ...n, author_name: author?.display_name ?? "Someone" }));
  }, [projectId]);
}

/** One line of the note's text for the list: Markdown marks and line breaks dropped. */
const preview = (body: string) => body.replace(/[#*_`>~-]+/g, " ").replace(/\s+/g, " ").trim();

/** A title for a note saved from a message: its first line of text, Markdown marks dropped, cut to fit. */
export function noteTitleFrom(text: string): string {
  const line = text.split("\n").map((l) => l.replace(/[#*_`>~|-]+/g, " ").replace(/\s+/g, " ").trim()).find(Boolean) ?? "Note";
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

export function NotesCard({ project }: { project: ProjectSummary }) {
  const { me } = useApp();
  const notes = useProjectNotes(project.id);
  const [filter, setFilter] = useState<Filter>("all");
  /** The note opened for reading. Reading is the default when a note is clicked; editing is a separate step. */
  const [open, setOpen] = useState<string | null>(null);
  /** The note being edited in place, or "new" for the one being added. */
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<NoteRow | null>(null);
  const manager = project.my_role === "host" || project.my_role === "admin";

  const all = notes.data;
  // Someone else deleted the note being read or edited: close it.
  useEffect(() => {
    if (!all) return;
    if (editing && editing !== "new" && !all.some((n) => n.id === editing)) setEditing(null);
    if (open && !all.some((n) => n.id === open)) setOpen(null);
  }, [all, editing, open]);

  const shown = useMemo(() => (all ?? []).filter((n) => (filter === "all" ? true : filter === "ai" ? n.by_ai : !n.by_ai)), [all, filter]);

  return (
    <section className="side-card notes-card" aria-label="Notes">
      <header className="side-card-head">
        <FileText size={ICON_SM} strokeWidth={STROKE} aria-hidden />
        <span className="side-card-title grow">
          <b className="truncate">Notes</b>
          {all && all.length > 0 && <span className="count-pill">{all.length}</span>}
        </span>
        <IconButton label="New note" className="sm" onClick={() => setEditing("new")} disabled={editing === "new"}>
          <Plus size={ICON_SM} strokeWidth={STROKE} />
        </IconButton>
      </header>
      {all && all.length > 0 && (
        <div className="notes-filter" role="tablist" aria-label="Filter notes">
          {([["all", "All"], ["ai", "By AI"], ["people", "By people"]] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={filter === id} className={`notes-tab ${filter === id ? "on" : ""}`} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="side-card-body notes-body">
        {all === undefined ? (
          <div className="folder-loading">{notes.error ? <span className="small muted">{notes.error}</span> : <Spinner />}</div>
        ) : (
          <>
            {editing === "new" && <NoteEditor projectId={project.id} onDone={() => setEditing(null)} />}
            {all.length === 0 && editing !== "new" && <p className="notes-empty small muted">No notes yet.<br />Say “take a note” in chat, or tap +.</p>}
            {all.length > 0 && shown.length === 0 && <p className="notes-empty small muted">Nothing here yet.</p>}
            {shown.map((n) =>
              editing === n.id ? (
                <NoteEditor
                  key={n.id}
                  projectId={project.id}
                  note={n}
                  onDone={() => {
                    setEditing(null);
                    setOpen(n.id);
                  }}
                />
              ) : open === n.id ? (
                <NoteReader key={n.id} note={n} onClose={() => setOpen(null)} onEdit={() => setEditing(n.id)} />
              ) : (
                <NoteRowView
                  key={n.id}
                  note={n}
                  canDelete={n.created_by === me.id || manager}
                  onOpen={() => setOpen(n.id)}
                  onEdit={() => {
                    setOpen(null);
                    setEditing(n.id);
                  }}
                  onDelete={() => setDeleting(n)}
                />
              ),
            )}
          </>
        )}
      </div>
      {deleting && (
        <ConfirmDialog
          title="Delete this note?"
          confirmLabel="Delete note"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteNote(project.id, deleting.id);
            notifyChanged();
          }}
        >
          <b className="strong">{deleting.title}</b> is deleted for everyone in {project.name}. This can't be undone.
        </ConfirmDialog>
      )}
    </section>
  );
}

function NoteRowView({ note, canDelete, onOpen, onEdit, onDelete }: { note: NoteRow; canDelete: boolean; onOpen: () => void; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className={`note-row ${note.by_ai ? "ai" : ""}`}>
      <button type="button" className="note-open" onClick={onOpen} aria-label={`Open note: ${note.title}`}>
        <span className="note-avatar">{note.by_ai ? <AiAvatar size={22} /> : note.created_by ? <Avatar id={note.created_by} name={note.author_name} size={22} /> : null}</span>
        <span className="note-text">
          <span className="note-title truncate">{note.title}</span>
          {note.body && <span className="note-preview small muted truncate">{preview(note.body)}</span>}
        </span>
        <span className="note-time small muted">{listTime(note.updated_at)}</span>
      </button>
      <span className="note-menu">
        <Menu
          label="Note options"
          align="end"
          items={[
            { label: "Edit", icon: <Pencil size={ICON_SM} strokeWidth={STROKE} />, onSelect: onEdit },
            ...(canDelete ? [{ label: "Delete", danger: true, icon: <Trash2 size={ICON_SM} strokeWidth={STROKE} />, onSelect: onDelete }] : []),
          ]}
          trigger={({ toggle, open }) => (
            <IconButton label="Note options" className={`sm note-more ${open ? "open" : ""}`} onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
              <MoreHorizontal size={ICON_SM} strokeWidth={STROKE} />
            </IconButton>
          )}
        />
      </span>
    </div>
  );
}

/** A note opened to read: the whole text as plain text, who wrote it and when. Nothing is editable until Edit is chosen. */
function NoteReader({ note, onClose, onEdit }: { note: NoteRow; onClose: () => void; onEdit: () => void }) {
  return (
    <article className={`note-reader ${note.by_ai ? "ai" : ""}`} aria-label={note.title} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <header className="note-reader-head">
        <span className="note-avatar">{note.by_ai ? <AiAvatar size={22} /> : note.created_by ? <Avatar id={note.created_by} name={note.author_name} size={22} /> : null}</span>
        <h3 className="note-reader-title">{note.title}</h3>
      </header>
      {note.body ? <div className="note-reader-body">{note.body}</div> : <p className="small muted">No text.</p>}
      <div className="note-edit-actions">
        <span className="small muted grow truncate">
          {note.by_ai ? "AI for " : ""}
          {note.author_name} · {listTime(note.updated_at)}
        </span>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
        <Button size="sm" variant="primary" onClick={onEdit} autoFocus>
          <Pencil size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Edit
        </Button>
      </div>
    </article>
  );
}

/** The in-place editor: a new note (no `note`) or an existing one. Cancel throws the changes away; Escape cancels. */
function NoteEditor({ projectId, note, onDone }: { projectId: string; note?: NoteRow; onDone: () => void }) {
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const clean = title.trim();
  const dirty = !note || clean !== note.title || body !== note.body;

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  async function save() {
    if (!clean || busy) return;
    if (!dirty) return onDone();
    setBusy(true);
    setError(null);
    try {
      if (note) await api.updateNote(projectId, note.id, { title: clean, body });
      else await api.addNote(projectId, { title: clean, body });
      notifyChanged();
      onDone();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  }

  return (
    <form
      className="note-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onDone();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void save();
        }
      }}
    >
      <input ref={titleRef} className="note-edit-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" maxLength={NOTE_LIMITS.titleChars} aria-label="Note title" />
      <textarea className="note-edit-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a note" maxLength={NOTE_LIMITS.bodyChars} rows={5} aria-label="Note text" />
      {error && <ErrorLine>{error}</ErrorLine>}
      <div className="note-edit-actions">
        {note && <span className="small muted grow truncate">{note.by_ai ? "AI for " : ""}{note.author_name}</span>}
        <Button size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" busy={busy} disabled={!clean}>
          Save
        </Button>
      </div>
    </form>
  );
}
