import { DESIGN_LIMITS, type ProjectDesign } from "@mc/shared";
import { Monitor, Plus, Shapes, Smartphone } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "../../api.ts";
import { Button, Dialog, ErrorLine, Field, ICON_SM, Spinner, STROKE, TextInput } from "../kit.tsx";

const BOARDS = [
  { id: "desktop", name: "Desktop", size: "1920 × 1080", Icon: Monitor },
  { id: "phone", name: "Phone", size: "390 × 844", Icon: Smartphone },
] as const;

const messageOf = (e: unknown, fallback = "Something went wrong.") => (e instanceof Error ? e.message : fallback);

/** A new, empty design: a name and the first board's size. It belongs to the project: everyone in it can open it. */
export function NewDesignDialog({ projectId, onCreated, onClose }: { projectId: string; onCreated: (path: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [board, setBoard] = useState<"desktop" | "phone">("desktop");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    setBusy(true);
    setError(null);
    try {
      const r = await api.designCreate(projectId, { name: name.trim(), board });
      onCreated(r.path);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title="New design" onClose={onClose}>
      <form className="col" style={{ gap: 16 }} onSubmit={submit}>
        <Field label="Name" htmlFor="design-name" hint="Everyone in the project can see and edit it.">
          <TextInput id="design-name" value={name} maxLength={DESIGN_LIMITS.nameChars} placeholder="Landing page" onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>
        <Field label="First board">
          <div className="board-tiles" role="radiogroup" aria-label="First board">
            {BOARDS.map(({ id, name, size, Icon }) => (
              <button key={id} type="button" role="radio" aria-checked={board === id} className={`board-tile ${board === id ? "on" : ""}`} onClick={() => setBoard(id)}>
                <Icon size={40} strokeWidth={1.25} aria-hidden />
                <span className="board-tile-name">{name}</span>
                <span className="board-tile-size">{size}</span>
              </button>
            ))}
          </div>
        </Field>
        <ErrorLine>{error}</ErrorLine>
        <div className="dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Cmd+K and the chat's "Design" button: the project's designs, and "New design". Type to filter, arrows and Enter to pick. */
export function DesignPicker({ projectId, current, onOpen, onNew, onClose }: { projectId: string; current: string | null; onOpen: (path: string) => void; onNew: () => void; onClose: () => void }) {
  const [designs, setDesigns] = useState<ProjectDesign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let live = true;
    api.designList(projectId).then(
      (r) => live && setDesigns(r.designs),
      (e: unknown) => {
        if (!live) return;
        setDesigns([]);
        setError(messageOf(e));
      },
    );
    return () => {
      live = false;
    };
  }, [projectId]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const found = (designs ?? []).filter((d) => !needle || d.name.toLowerCase().includes(needle));
    return [{ kind: "new" as const, path: "", name: "New design" }, ...found.map((d) => ({ kind: "open" as const, path: d.path, name: d.name }))];
  }, [designs, q]);
  useEffect(() => setAt(0), [q]);
  useEffect(() => list.current?.querySelector(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" }), [at]);

  const choose = (i: number) => {
    const r = rows[i];
    if (!r) return;
    if (r.kind === "new") onNew();
    else onOpen(r.path);
  };

  return (
    <Dialog label="Designs" onClose={onClose} width={480}>
      <div className="col dz-picker">
        <TextInput
          value={q}
          placeholder="Search designs"
          aria-label="Search designs"
          onChange={(e) => setQ(e.target.value)}
          data-autofocus
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setAt((a) => (a + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(at);
            }
          }}
        />
        <ul className="dz-picker-list" role="listbox" aria-label="Designs" ref={list}>
          {rows.map((r, i) => (
            <li key={r.kind + r.path}>
              <button type="button" role="option" data-i={i} aria-selected={i === at} className={`dz-picker-row ${i === at ? "on" : ""}`} onMouseEnter={() => setAt(i)} onClick={() => choose(i)}>
                {r.kind === "new" ? <Plus size={ICON_SM} strokeWidth={STROKE} aria-hidden /> : <Shapes size={ICON_SM} strokeWidth={STROKE} aria-hidden />}
                <span className="grow truncate">{r.name}</span>
                {r.kind === "open" && r.path === current && <span className="small muted truncate dz-picker-path">Open now</span>}
              </button>
            </li>
          ))}
          {designs === null && (
            <li className="small muted row pad">
              <Spinner /> Looking for designs…
            </li>
          )}
          {designs && designs.length === 0 && !error && <li className="small muted pad">No designs in this project yet.</li>}
        </ul>
        <ErrorLine>{error}</ErrorLine>
      </div>
    </Dialog>
  );
}
