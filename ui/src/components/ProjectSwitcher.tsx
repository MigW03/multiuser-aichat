import type { ProjectSummary } from "@mc/shared";
import { Check, ChevronDown, ChevronRight, Plus, Search } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../data.tsx";
import { pushRecent, stepIndex, switcherRows } from "../lib/projectSwitch.ts";
import { PREF, readPref, writePref } from "../lib/prefs.ts";
import { navigate } from "../lib/router.ts";
import { CreateProjectDialog } from "./Dialogs.tsx";
import { ProjectTile } from "./Join.tsx";
import { ICON_SM, STROKE, UnreadBadge } from "./kit.tsx";

const WIDTH = 300;
const MARGIN = 8;

/**
 * The current project's name with a chevron. A click opens a small popover: search, the projects opened lately
 * (unread counts beside them), and "All projects" / "New" at the bottom. Type to filter, ↑ ↓ to move, Enter to open, Esc to close.
 * `variant` "panel" is the big name in the left panel's header; "header" is the compact chip in the chat header.
 */
export function ProjectSwitcher({ project, projects, variant, onNavigate }: { project: ProjectSummary; projects: ProjectSummary[] | undefined; variant: "panel" | "header"; onNavigate?: () => void }) {
  const { me } = useApp();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [at, setAt] = useState<CSSProperties | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;

  // Remember which projects were opened, newest first, for the RECENT order.
  const [recent, setRecent] = useState<unknown>(() => readPref(PREF.recentProjects(me.id), []));
  useEffect(() => {
    setRecent((old: unknown) => {
      const next = pushRecent(old, project.id);
      writePref(PREF.recentProjects(me.id), next);
      return next;
    });
  }, [project.id, me.id]);

  const rows = useMemo(() => switcherRows(projects ?? [], recent, project.id, query), [projects, recent, project.id, query]);

  function close(refocus = false) {
    setOpen(false);
    setQuery("");
    setActive(-1);
    if (refocus) btn.current?.focus();
  }

  // Sit under the trigger, kept inside the window.
  useLayoutEffect(() => {
    if (!open) return setAt(null);
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(WIDTH, window.innerWidth - 2 * MARGIN);
      const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - MARGIN - width));
      setAt({ position: "fixed", top: r.bottom + 6, left, width, maxHeight: Math.max(160, window.innerHeight - r.bottom - 6 - MARGIN) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !btn.current?.contains(t)) close();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open && at) input.current?.focus({ preventScroll: true });
  }, [open, !!at]); // eslint-disable-line react-hooks/exhaustive-deps

  function openProject(p: ProjectSummary) {
    close();
    if (p.id === project.id) return;
    navigate({ name: "project", projectId: p.id, chatId: null });
    onNavigate?.();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => stepIndex(i, e.key === "ArrowDown" ? 1 : -1, rows.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = rows[active] ?? (query.trim() ? rows[0] : undefined);
      if (pick) openProject(pick);
    }
  }

  // Keep the highlighted row in view.
  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${uid}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, uid]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`switch-btn ${variant}${open ? " open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${project.name}, switch project`}
        title="Switch project"
        onClick={() => (open ? close() : setOpen(true))}
      >
        {variant === "header" && <ProjectTile name={project.name} size={22} />}
        <span className={`switch-name truncate ${variant}`}>{project.name}</span>
        <ChevronDown size={ICON_SM} strokeWidth={STROKE} className="muted switch-chev" aria-hidden />
      </button>

      {open &&
        at &&
        createPortal(
          <div ref={box} className="popover switcher" style={at} role="dialog" aria-label="Switch project" onKeyDown={onKeyDown}>
            <label className="search-field">
              <Search size={ICON_SM} strokeWidth={STROKE} aria-hidden />
              <input
                ref={input}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(-1);
                }}
                placeholder="Switch project…"
                aria-label="Switch project"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={active >= 0 ? `${uid}-opt-${active}` : undefined}
                autoComplete="off"
                spellCheck={false}
                maxLength={80}
              />
            </label>
            <div className="switch-list" id={listId} role="listbox" aria-label={query.trim() ? "Matching projects" : "Recent projects"}>
              <div className="switch-label">{query.trim() ? "Results" : "Recent"}</div>
              {projects === undefined ? null : rows.length === 0 ? (
                <p className="switch-empty small muted">No projects match.</p>
              ) : (
                rows.map((p, i) => {
                  const current = p.id === project.id;
                  return (
                    <button
                      key={p.id}
                      id={`${uid}-opt-${i}`}
                      type="button"
                      role="option"
                      aria-selected={i === active}
                      className={`switch-item${i === active ? " active" : ""}${current ? " current" : ""}`}
                      tabIndex={-1}
                      onMouseMove={() => i !== active && setActive(i)}
                      onClick={() => openProject(p)}
                    >
                      <ProjectTile name={p.name} size={24} />
                      <span className="grow truncate">{p.name}</span>
                      {current ? (
                        <span className="switch-current small">
                          <Check size={ICON_SM} strokeWidth={STROKE} aria-hidden /> current
                        </span>
                      ) : (
                        <UnreadBadge people={p.unread_people} ai={p.unread_ai} />
                      )}
                    </button>
                  );
                })
              )}
            </div>
            <div className="switch-foot">
              <button
                type="button"
                className="switch-foot-btn"
                onClick={() => {
                  close();
                  navigate({ name: "home" });
                  onNavigate?.();
                }}
              >
                All projects <ChevronRight size={ICON_SM} strokeWidth={STROKE} aria-hidden />
              </button>
              <button
                type="button"
                className="switch-foot-btn accent"
                onClick={() => {
                  close();
                  setCreating(true);
                }}
              >
                <Plus size={ICON_SM} strokeWidth={STROKE} aria-hidden /> New
              </button>
            </div>
          </div>,
          document.body,
        )}

      {creating && <CreateProjectDialog onClose={() => setCreating(false)} />}
    </>
  );
}
