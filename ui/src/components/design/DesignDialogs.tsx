import { designName, designSlug, DESIGN_SUFFIX, emptyDesign } from "@mc/shared";
import { Plus, Shapes } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "../../api.ts";
import { Button, Dialog, ErrorLine, Field, ICON_SM, Spinner, STROKE, TextInput } from "../kit.tsx";

const messageOf = (e: unknown, fallback = "Something went wrong.") => (e instanceof Error ? e.message : fallback);

/** A new, empty design: a name, the first board's size, and the shared folder it goes in (under designs/). */
export function NewDesignDialog({ projectId, folders, onCreated, onClose }: { projectId: string; folders: string[]; onCreated: (path: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [board, setBoard] = useState<"desktop" | "phone">("desktop");
  const [folder, setFolder] = useState(folders[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `${folder}/designs/${designSlug(name || "design")}${DESIGN_SUFFIX}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    setBusy(true);
    setError(null);
    try {
      const r = await api.designSave(projectId, path, emptyDesign(board), null);
      onCreated(r.path);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  if (folders.length === 0) {
    return (
      <Dialog title="New design" onClose={onClose}>
        <div className="col" style={{ gap: 16 }}>
          <p className="small muted">A design is saved as a file in a shared folder. Share a folder in this project first (from the desktop app), then make the design there.</p>
          <div className="dialog-actions">
            <Button variant="primary" onClick={onClose}>
              OK
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="New design" onClose={onClose}>
      <form className="col" style={{ gap: 16 }} onSubmit={submit}>
        <Field label="Name" htmlFor="design-name" hint={<span className="truncate block">{path}</span>}>
          <TextInput id="design-name" value={name} maxLength={60} placeholder="Landing page" onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>
        <Field label="First board">
          <span className="segmented" role="radiogroup" aria-label="First board">
            {(["desktop", "phone"] as const).map((b) => (
              <button key={b} type="button" role="radio" aria-checked={board === b} className={`seg ${board === b ? "on" : ""}`} onClick={() => setBoard(b)}>
                {b === "desktop" ? "Desktop · 1440" : "Phone · 390"}
              </button>
            ))}
          </span>
        </Field>
        {folders.length > 1 && (
          <Field label="Folder" htmlFor="design-folder">
            <select id="design-folder" className="input" value={folder} onChange={(e) => setFolder(e.target.value)}>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </Field>
        )}
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

/** Cmd+K and the chat's "Design" button: the designs in the shared folders, and "New design". Type to filter, arrows and Enter to pick. */
export function DesignPicker({ projectId, current, onOpen, onNew, onClose }: { projectId: string; current: string | null; onOpen: (path: string) => void; onNew: () => void; onClose: () => void }) {
  const [paths, setPaths] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let live = true;
    api.designList(projectId).then(
      (r) => live && setPaths(r.paths),
      (e: unknown) => {
        if (!live) return;
        setPaths([]);
        setError(messageOf(e));
      },
    );
    return () => {
      live = false;
    };
  }, [projectId]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const found = (paths ?? []).filter((p) => !needle || p.toLowerCase().includes(needle));
    return [{ kind: "new" as const, path: "" }, ...found.map((path) => ({ kind: "open" as const, path }))];
  }, [paths, q]);
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
                <span className="grow truncate">{r.kind === "new" ? "New design" : designName(r.path)}</span>
                {r.kind === "open" && <span className="small muted truncate dz-picker-path">{r.path === current ? "Open now" : r.path}</span>}
              </button>
            </li>
          ))}
          {paths === null && (
            <li className="small muted row pad">
              <Spinner /> Looking for designs…
            </li>
          )}
          {paths && paths.length === 0 && !error && <li className="small muted pad">No designs yet in the shared folders.</li>}
        </ul>
        <ErrorLine>{error}</ErrorLine>
      </div>
    </Dialog>
  );
}
