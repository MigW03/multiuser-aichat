import { designMarker, designName, type DesignAiEvent, type DesignAskEvent, type DesignHandoverEvent, type DesignRef, type DesignSavedEvent } from "@mc/shared";
import { Code2, Keyboard, Maximize2, Minimize2, PanelRightClose, PanelRightOpen, Redo2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiRequestError } from "../../api.ts";
import { focusComposer, hasOpenChat, sendInOpenChat } from "../../lib/designBus.ts";
import { claimWins, editorOf, viewersOf } from "../../lib/designEditor.ts";
import { boardHash, boardsOf, byNid, changedLayers, layerPath, nidOf, parseDesign, serializeDesign } from "../../lib/designModel.ts";
import { joinProject, onPresence, onProjectEvent, sendProjectEvent, setPresence, type ProjectPresence } from "../../lib/projectChannel.ts";
import { Avatar, Button, Dialog, ErrorLine, Field, ICON, ICON_SM, IconButton, Spinner, STROKE, TextInput, useToast } from "../kit.tsx";
import { Canvas, codeLink, type CanvasHandle, type Commit } from "./Canvas.tsx";
import { Inspector } from "./Inspector.tsx";

// Design mode's card: the top bar, the canvas and the inspector for one design file. It loads the file through the shared
// folder, keeps every change as one undo step, saves (naming the version it started from, so nobody's work is overwritten),
// follows what the AI and other people change, and lets one person edit at a time while the others watch.

const SAVE_DELAY_MS = 350;
const UNDO_MAX = 100;
const AI_LOCK_MS = 120_000;
const CLAIM_DELAY_MS = 1500;

type Props = {
  projectId: string;
  path: string;
  me: { id: string; name: string; avatar: string | null };
  /** Changes with each request to open (the same design again, or a design card's "Build in code"). */
  request: { n: number; select?: string[]; build?: boolean };
  full: boolean;
  narrow: boolean;
  onFull: (full: boolean) => void;
  onClose: () => void;
  onAskAI: (ref: DesignRef) => void;
  /** A change made on this canvas, for the next message to the AI. */
  onEdit: (desc: string) => void;
  onOpenFile: (path: string) => void;
};

type Loaded = { root: HTMLElement; removed: string[] };

export function DesignPanel({ projectId, path, me, request, full, narrow, onFull, onClose, onAskAI, onEdit, onOpenFile }: Props) {
  const toast = useToast();
  const canvas = useRef<CanvasHandle>(null);
  const [doc, setDoc] = useState<Loaded | null>(null);
  const [version, setVersion] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [status, setStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const [selection, setSelection] = useState<string[]>([]);
  const [flash, setFlash] = useState<string[]>([]);
  const [ai, setAi] = useState<{ chatId: string; by: string } | null>(null);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [inspector, setInspector] = useState(!narrow);
  const [sheet, setSheet] = useState(false);
  const [build, setBuild] = useState<string[] | null>(null);
  const [presence, setPres] = useState<Record<string, ProjectPresence>>({});
  const [claim, setClaim] = useState<number | null>(null);
  const [asking, setAsking] = useState<{ from: string; name: string } | null>(null);
  const [asked, setAsked] = useState(false);

  const docRef = useRef(doc);
  docRef.current = doc;
  const sha = useRef<string | null>(null);
  const savedText = useRef("");
  const undo = useRef<string[]>([]);
  const redo = useRef<string[]>([]);
  const saveTimer = useRef<number | undefined>(undefined);
  const saving = useRef(false);
  const again = useRef(false);
  const flashTimer = useRef<number | undefined>(undefined);
  const aiTimer = useRef<number | undefined>(undefined);
  const handedAt = useRef(0);
  const gotHandover = useRef(0);
  const pending = useRef<{ select?: string[]; build?: boolean } | null>(null);

  const syncHist = () => setHist({ undo: undo.current.length, redo: redo.current.length });

  // ---- loading
  const show = useCallback((text: string, fileSha: string, opts: { flashFrom?: HTMLElement; keepHistory?: boolean } = {}) => {
    const parsed = parseDesign(text);
    if (opts.flashFrom) {
      const changed = changedLayers(opts.flashFrom, parsed.root);
      setFlash(changed);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash([]), 2200);
    }
    sha.current = fileSha;
    savedText.current = serializeDesign(parsed.root);
    setDoc({ root: parsed.root, removed: parsed.removed });
    setVersion((v) => v + 1);
    setSelection((sel) => sel.filter((n) => byNid(parsed.root, n)));
    setLoadError(null);
    if (!opts.keepHistory) {
      undo.current = [];
      redo.current = [];
    }
    syncHist();
  }, []);

  const load = useCallback(
    async (opts: { flash?: boolean; keepHistory?: boolean; pushUndo?: boolean } = {}) => {
      try {
        const r = await api.designRead(projectId, path);
        const before = docRef.current?.root;
        if (opts.pushUndo && before) {
          const text = serializeDesign(before);
          if (text !== serializeDesign(parseDesign(r.text).root)) {
            undo.current = [...undo.current, text].slice(-UNDO_MAX);
            redo.current = [];
          }
        }
        show(r.text, r.sha, { ...(opts.flash && before ? { flashFrom: before } : {}), keepHistory: opts.keepHistory || opts.pushUndo });
        setStatus("saved");
        setSaveError(null);
      } catch (e) {
        if (!docRef.current) setLoadError(e instanceof Error ? e.message : "The design could not be opened.");
        else toast.push(e instanceof Error ? e.message : "The design could not be reloaded.", "error");
      }
    },
    [projectId, path, show, toast],
  );

  useEffect(() => {
    setDoc(null);
    setLoadError(null);
    setSelection([]);
    setClaim(null);
    setAi(null);
    void load();
    return () => {
      window.clearTimeout(saveTimer.current);
      window.clearTimeout(flashTimer.current);
      window.clearTimeout(aiTimer.current);
    };
  }, [load]);

  // A request to open (again): select what it names, or open "Build in code".
  useEffect(() => {
    pending.current = { ...(request.select ? { select: request.select } : {}), ...(request.build ? { build: true } : {}) };
  }, [request.n, request.select, request.build]);
  useEffect(() => {
    const p = pending.current;
    if (!doc || !p) return;
    pending.current = null;
    if (p.select?.length) {
      const sel = p.select.filter((n) => byNid(doc.root, n));
      setSelection(sel);
      if (sel.length) requestAnimationFrame(() => canvas.current?.zoomToSelection());
    }
    if (p.build) setBuild(boardsOf(doc.root).map((b) => b.getAttribute("data-board") ?? ""));
  }, [doc, request.n]);

  // ---- who edits
  useEffect(() => {
    const leave = joinProject(projectId, me.id);
    const off = onPresence(projectId, setPres);
    return () => {
      off();
      setPresence(projectId, { design: null, editing: false });
      leave();
    };
  }, [projectId, me.id]);

  const other = editorOf(presence, path, me.id);
  const editing = claim !== null && claimWins(me.id, claim, other);
  useEffect(() => {
    setPresence(projectId, { design: path, editing: claim !== null, ...(claim !== null ? { since: claim } : {}), name: me.name });
  }, [projectId, path, claim, me.name]);
  // Nobody else editing for a moment: this person takes the pen. Someone who started first wins it back.
  useEffect(() => {
    if (!doc) return;
    if (claim !== null) {
      if (!editing && Date.now() - gotHandover.current > 4000) setClaim(null);
      return;
    }
    if (other) return;
    const wait = Math.max(CLAIM_DELAY_MS, handedAt.current + 6000 - Date.now());
    const t = window.setTimeout(() => setClaim(Date.now()), wait);
    return () => window.clearTimeout(t);
  }, [doc, claim, editing, other]);
  useEffect(() => {
    if (editing) setAsked(false);
  }, [editing]);

  // ---- saving
  const save = useCallback(async () => {
    const d = docRef.current;
    if (!d) return;
    if (saving.current) {
      again.current = true;
      return;
    }
    const text = serializeDesign(d.root);
    if (text === savedText.current) return setStatus("saved");
    saving.current = true;
    setStatus("saving");
    try {
      const r = await api.designSave(projectId, path, text, sha.current);
      sha.current = r.sha;
      savedText.current = text;
      setSaveError(null);
      setStatus(serializeDesign(d.root) === text ? "saved" : "unsaved");
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "stale") {
        toast.push("The design was changed somewhere else, so it was reloaded. Your last change may need doing again.", "error");
        void load({ keepHistory: true });
      } else {
        setStatus("unsaved");
        setSaveError(e instanceof Error ? e.message : "The design could not be saved.");
      }
    } finally {
      saving.current = false;
      if (again.current) {
        again.current = false;
        void save();
      }
    }
  }, [projectId, path, load, toast]);

  const queueSave = useCallback(() => {
    setStatus("unsaved");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS);
  }, [save]);
  const flush = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    return save();
  }, [save]);

  // Unsaved changes are written before the panel goes away.
  useEffect(() => () => void flush(), [flush]);

  const readOnly = !doc || !editing || !!ai;

  const commit: Commit = useCallback(
    (desc, mutate, select) => {
      const d = docRef.current;
      if (!d || readOnly) {
        if (d) toast.push(ai ? "The AI is changing this design. You can edit again when it is done." : "Someone else is editing this design. Ask to edit first.");
        return false;
      }
      const before = serializeDesign(d.root);
      mutate(d.root);
      const after = serializeDesign(d.root);
      setVersion((v) => v + 1);
      if (after === before) return false;
      undo.current = [...undo.current, before].slice(-UNDO_MAX);
      redo.current = [];
      syncHist();
      onEdit(desc);
      if (select) setSelection(select);
      queueSave();
      return true;
    },
    [readOnly, ai, toast, onEdit, queueSave],
  );

  const step = useCallback(
    (back: boolean) => {
      const d = docRef.current;
      if (!d || readOnly) return;
      const from = back ? undo.current : redo.current;
      const text = from.at(-1);
      if (text === undefined) return;
      const current = serializeDesign(d.root);
      if (back) {
        undo.current = undo.current.slice(0, -1);
        redo.current = [...redo.current, current];
      } else {
        redo.current = redo.current.slice(0, -1);
        undo.current = [...undo.current, current];
      }
      const parsed = parseDesign(text);
      setDoc({ root: parsed.root, removed: d.removed });
      setVersion((v) => v + 1);
      setSelection((sel) => sel.filter((n) => byNid(parsed.root, n)));
      syncHist();
      onEdit(back ? "undid a change" : "redid a change");
      queueSave();
    },
    [readOnly, onEdit, queueSave],
  );

  // ---- what others do
  useEffect(() => {
    const leave = joinProject(projectId, me.id);
    const offs = [
      onProjectEvent(projectId, "design_saved", (p) => {
        const e = p as Partial<DesignSavedEvent>;
        if (e.path !== path || e.sha === sha.current || e.by === me.id || saving.current) return;
        void load({ flash: true, keepHistory: true });
      }),
      onProjectEvent(projectId, "design_ai", (p) => {
        const e = p as Partial<DesignAiEvent>;
        if (e.path !== path || typeof e.chatId !== "string" || typeof e.by !== "string") return;
        window.clearTimeout(aiTimer.current);
        if (e.state === "start") {
          void flush();
          setAi({ chatId: e.chatId, by: e.by });
          aiTimer.current = window.setTimeout(() => setAi(null), AI_LOCK_MS);
        } else {
          setAi(null);
          if (e.sha !== sha.current) void load({ flash: true, pushUndo: true });
        }
      }),
      onProjectEvent(projectId, "design_ask", (p) => {
        const e = p as Partial<DesignAskEvent>;
        if (e.path === path && typeof e.from === "string" && e.from !== me.id) setAsking({ from: e.from, name: typeof e.name === "string" ? e.name.slice(0, 60) : "Someone" });
      }),
      onProjectEvent(projectId, "design_handover", (p) => {
        const e = p as Partial<DesignHandoverEvent>;
        if (e.path !== path || e.to !== me.id) return;
        gotHandover.current = Date.now();
        setClaim(Date.now());
        toast.push("You can edit the design now.");
      }),
    ];
    return () => {
      for (const off of offs) off();
      leave();
    };
  }, [projectId, path, me.id, load, flush, toast]);

  const handOver = async () => {
    if (!asking) return;
    await flush();
    sendProjectEvent(projectId, "design_handover", { path, from: me.id, to: asking.from } satisfies DesignHandoverEvent);
    handedAt.current = Date.now();
    setClaim(null);
    setAsking(null);
  };
  const askToEdit = () => {
    sendProjectEvent(projectId, "design_ask", { path, from: me.id, name: me.name } satisfies DesignAskEvent);
    setAsked(true);
  };

  // A board the AI just built (it has data-code and no data-built) is stamped with what it looked like then, so later
  // canvas changes show "Changed since code". Only the editor writes it.
  useEffect(() => {
    const d = docRef.current;
    if (!d || !editing || ai) return;
    const fresh = boardsOf(d.root).filter((b) => b.hasAttribute("data-code") && !b.hasAttribute("data-built"));
    if (!fresh.length) return;
    for (const b of fresh) b.setAttribute("data-built", boardHash(b));
    setVersion((v) => v + 1);
    queueSave();
  }, [version, editing, ai, queueSave]);

  // ---- keys for the whole card: undo, redo, F6 to move between chat, canvas and inspector
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F6") {
        e.preventDefault();
        const spots = [document.querySelector<HTMLElement>(".composer-input textarea"), document.querySelector<HTMLElement>(".dz-viewport"), document.querySelector<HTMLElement>(".dz-insp button, .dz-insp input")].filter((x): x is HTMLElement => !!x);
        const at = spots.findIndex((s) => s === document.activeElement || s.contains(document.activeElement));
        spots[(at + (e.shiftKey ? spots.length - 1 : 1)) % spots.length]?.focus();
        return;
      }
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.(".dz-card") || t.closest("input, textarea, select, [contenteditable]")) return;
      const mod = /mac/i.test(navigator.platform) ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        step(!e.shiftKey);
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        step(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  // ---- asking the AI, building code
  const askAI = () => {
    const d = docRef.current;
    if (!d) return;
    const names = selection
      .map((n) => byNid(d.root, n))
      .filter((x): x is HTMLElement => !!x)
      .map(layerPath)
      .join(", ");
    onAskAI({ path, ...(selection.length ? { sel: selection, names } : {}) });
  };

  const send = async (ref: DesignRef, text: string) => {
    if (!hasOpenChat()) {
      toast.push("Open a chat in this project first, then try again.", "error");
      return false;
    }
    await flush();
    const ok = await sendInOpenChat(`${designMarker(ref)}\n${text}`);
    if (ok) focusComposer();
    return ok;
  };
  const updateCode = (boards: string[]) => void send({ path, action: "update-code", boards }, `Update the code of ${boards.join(", ")} to match the design.`);

  const viewers = useMemo(() => viewersOf(presence, path).filter((v) => v.id !== me.id), [presence, path, me.id]);
  const boardNames = doc ? boardsOf(doc.root).map((b) => b.getAttribute("data-board") ?? "") : [];
  const folder = path.split("/")[0] ?? "";

  return (
    <section className={`chat-card dz-card ${full ? "full" : ""}`} aria-label={`Design ${designName(path)}`}>
      <header className="preview-bar dz-bar">
        <span className="dz-title truncate">
          <b className="truncate">{designName(path)}</b>
          <span className="small muted truncate">{path.split("/").slice(0, -1).join("/")}</span>
        </span>
        <span className="small muted dz-status" role="status">
          {saveError ? <span className="danger-text">Not saved</span> : status === "saving" ? "Saving…" : status === "unsaved" ? "Unsaved" : doc ? "Saved" : ""}
        </span>
        <span className="grow" />
        {viewers.length > 0 && (
          <span className="header-people" aria-label="Also open by">
            {viewers.slice(0, 4).map((v) => (
              <Avatar key={v.id} id={v.id} name={v.name} size={22} ring online={v.editing} />
            ))}
          </span>
        )}
        <IconButton label="Undo" disabled={readOnly || hist.undo === 0} onClick={() => step(true)} className="sm">
          <Undo2 size={ICON} strokeWidth={STROKE} />
        </IconButton>
        <IconButton label="Redo" disabled={readOnly || hist.redo === 0} onClick={() => step(false)} className="sm">
          <Redo2 size={ICON} strokeWidth={STROKE} />
        </IconButton>
        <IconButton label="Shortcuts" onClick={() => setSheet(true)} className="sm">
          <Keyboard size={ICON} strokeWidth={STROKE} />
        </IconButton>
        <Button size="sm" variant="primary" disabled={!doc || boardNames.length === 0} onClick={() => setBuild(selectedBoards(doc, selection) ?? boardNames)}>
          <Code2 size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Build in code
        </Button>
        <IconButton label={inspector ? "Hide inspector" : "Show inspector"} onClick={() => setInspector((v) => !v)} className="sm">
          {inspector ? <PanelRightClose size={ICON} strokeWidth={STROKE} /> : <PanelRightOpen size={ICON} strokeWidth={STROKE} />}
        </IconButton>
        {!narrow && (
          <IconButton label={full ? "Show the chat" : "Fill the main panel"} onClick={() => onFull(!full)} className="sm">
            {full ? <Minimize2 size={ICON} strokeWidth={STROKE} /> : <Maximize2 size={ICON} strokeWidth={STROKE} />}
          </IconButton>
        )}
        <IconButton label="Close design" onClick={onClose} className="sm">
          <X size={ICON} strokeWidth={STROKE} />
        </IconButton>
      </header>

      {ai ? (
        <div className="dz-banner ai" role="status">
          <span className="grow">The AI is changing this design. You can look and select; editing waits until it is done.</span>
          <Button size="sm" variant="ghost" onClick={() => void api.stop(ai.chatId).catch(() => undefined)}>
            Stop
          </Button>
        </div>
      ) : doc && !editing && other ? (
        <div className="dz-banner" role="status">
          <span className="grow">
            <b>{other.name}</b> is editing. You see the changes live.
          </span>
          <Button size="sm" disabled={asked} onClick={askToEdit}>
            {asked ? "Asked" : "Ask to edit"}
          </Button>
        </div>
      ) : null}
      {asking && editing && (
        <div className="dz-banner" role="alert">
          <span className="grow">
            <b>{asking.name}</b> wants to edit this design.
          </span>
          <Button size="sm" variant="primary" onClick={() => void handOver()}>
            Hand over
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>
            Keep editing
          </Button>
        </div>
      )}
      {saveError && (
        <div className="dz-banner danger" role="alert">
          <span className="grow">{saveError}</span>
          <Button size="sm" onClick={() => void save()}>
            Try again
          </Button>
        </div>
      )}
      {doc && doc.removed.length > 0 && (
        <div className="dz-banner" role="status">
          <span className="grow small">Removed on open, because designs never run code or load outside content: {doc.removed.slice(0, 4).join(", ")}{doc.removed.length > 4 ? "…" : ""}.</span>
        </div>
      )}

      <div className="dz-body">
        {loadError ? (
          <div className="preview-empty">
            <p className="muted">{loadError}</p>
            <Button onClick={() => void load()}>Try again</Button>
          </div>
        ) : !doc ? (
          <div className="preview-empty">
            <Spinner />
          </div>
        ) : (
          <>
            <Canvas
              ref={canvas}
              root={doc.root}
              version={version}
              selection={selection}
              onSelect={setSelection}
              commit={commit}
              readOnly={readOnly}
              flash={flash}
              onAskAI={askAI}
              onBuild={(boards) => setBuild(boards)}
              onUpdateCode={updateCode}
              onOpenCode={onOpenFile}
              codeOf={codeLink}
              onToast={(t) => toast.push(t)}
              onShortcuts={() => setSheet(true)}
              onExit={focusComposer}
            />
            {inspector && <Inspector root={doc.root} version={version} selection={selection} onSelect={setSelection} commit={commit} readOnly={readOnly} boxOf={(n) => canvas.current?.boxOf(n) ?? null} />}
          </>
        )}
      </div>

      {sheet && <ShortcutSheet onClose={() => setSheet(false)} />}
      {build && doc && (
        <BuildDialog
          boards={boardNames}
          initial={build}
          folder={folder}
          onClose={() => setBuild(null)}
          onBuild={async (boards, where, note) => {
            const ok = await send({ path, action: "build", boards, ...(where ? { where } : {}) }, `Build ${boards.join(", ")} in code${where ? ` in ${where}` : ""}.${note ? `\n${note}` : ""}`);
            if (ok) setBuild(null);
          }}
        />
      )}
    </section>
  );
}

function selectedBoards(doc: Loaded | null, selection: string[]): string[] | null {
  if (!doc) return null;
  const names = boardsOf(doc.root)
    .filter((b) => selection.includes(nidOf(b) ?? ""))
    .map((b) => b.getAttribute("data-board") ?? "");
  return names.length ? names : null;
}

/** "Build in code": which boards, where in the shared folder, and a note for the AI. Sends a chat message everyone sees. */
function BuildDialog({ boards, initial, folder, onBuild, onClose }: { boards: string[]; initial: string[]; folder: string; onBuild: (boards: string[], where: string, note: string) => Promise<void>; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>(initial.filter((b) => boards.includes(b)).length ? initial.filter((b) => boards.includes(b)) : boards);
  const [where, setWhere] = useState(folder);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="Build in code" onClose={onClose}>
      <form
        className="col"
        style={{ gap: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!picked.length) return;
          setBusy(true);
          void onBuild(picked, where.trim(), note.trim()).finally(() => setBusy(false));
        }}
      >
        <Field label="Boards">
          <div className="dz-check-list">
            {boards.map((b) => (
              <label key={b} className="row small">
                <input type="checkbox" checked={picked.includes(b)} onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, b] : cur.filter((x) => x !== b)))} />
                {b}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Where" htmlFor="build-where" hint="A folder in the shared folder. The AI reads the code there and follows its stack and components.">
          <TextInput id="build-where" value={where} maxLength={200} onChange={(e) => setWhere(e.target.value)} placeholder="my-app/web/src" />
        </Field>
        <Field label="Note for the AI (optional)" htmlFor="build-note">
          <TextInput id="build-note" value={note} maxLength={400} onChange={(e) => setNote(e.target.value)} placeholder="Use our Button component, route /landing" data-autofocus />
        </Field>
        <p className="small muted">This sends a message in the chat. Code changes come as approval cards, as usual.</p>
        <ErrorLine>{picked.length ? null : "Pick at least one board."}</ErrorLine>
        <div className="dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!picked.length}>
            Build
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
const M = isMac ? "⌘" : "Ctrl+";
const SHORTCUTS: [string, [string, string][]][] = [
  [
    "Select and move around",
    [
      ["Into a layer / out to its parent", "Enter / ⇧Enter or Esc"],
      ["Next / previous layer", "Tab / ⇧Tab"],
      ["Select all in the parent", `${M}A`],
      ["Deepest layer under the pointer", `${M}click`],
      ["Add to the selection", "⇧click"],
      ["Measure to another layer", "hold Alt"],
      ["Pan", "Space + drag, or scroll"],
      ["Zoom", `${M}scroll, ${M}+ / ${M}-`],
      ["Zoom to fit / selection / 100%", "⇧1 / ⇧2 / ⇧0"],
    ],
  ],
  [
    "Change",
    [
      ["Nudge 1 px / 10 px (in a stack: move earlier, later)", "Arrows / ⇧Arrows"],
      ["Resize 1 px / 10 px", `${M}Arrows / ${M}⇧Arrows`],
      ["Edit text", "Enter or double-click"],
      ["Duplicate / delete", `${M}D / ⌫`],
      ["Copy / paste", `${M}C / ${M}V`],
      ["Wrap in a stack / remove the frame", `⇧A / ${M}⇧G`],
      ["Undo / redo", `${M}Z / ${M}⇧Z`],
      ["Snap off while dragging", isMac ? "hold Ctrl" : "—"],
      ["Tools: move, frame, text, box, hand", "V F T R H"],
      ["Ask the AI about the selection", `${M}L`],
      ["Chat, canvas, inspector", "F6"],
    ],
  ],
];

function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Design shortcuts" onClose={onClose} width={560}>
      <div className="dz-sheet">
        {SHORTCUTS.map(([title, rows]) => (
          <section key={title}>
            <h3 className="dz-section-title">{title}</h3>
            <table>
              <tbody>
                {rows.map(([what, keys]) => (
                  <tr key={what}>
                    <td className="small">{what}</td>
                    <td className="small muted dz-keys">{keys}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
