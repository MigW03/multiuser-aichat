import { FOLDER_LIMITS, showSupabaseTab, showVercelTab, type AiEditState, type FolderListResult, type GitStatusResult, type ProjectSummary } from "@mc/shared";
import { Check, Database, File, FilePlus, Folder, FolderOpen, FolderPlus, GitBranch, Home, MoreHorizontal, PanelRightClose, PanelRightOpen, Plus, RefreshCw, Triangle, TriangleAlert, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiRequestError } from "../api.ts";
import { notifyChanged, onChanged, useApp } from "../data.tsx";
import { folderBridge, useLocalFolder, useProjectShares, useScripts, type Dropped, type FolderBridge, type PickResult, type ShareRow } from "../lib/folder.ts";
import { pickedTab, tabShowsName, type FilesTab } from "../lib/filesTabs.ts";
import { PREF, readPref, writePref } from "../lib/prefs.ts";
import { showScriptsTab } from "../lib/scriptsTab.ts";
import { useSupabaseState } from "../lib/supabaseState.ts";
import { vercelTabDot } from "../lib/vercelFormat.ts";
import { useVercelState } from "../lib/vercelState.ts";
import { DiffView } from "./Changes.tsx";
import { NoticeBody, shareFolderNotice } from "./Notice.tsx";
import { NotesCard } from "./NotesUi.tsx";
import { SplitResizer, useSplit } from "./PanelResizer.tsx";
import { ScriptsBody, scriptsDot } from "./ScriptsUi.tsx";
import { SupabaseBody } from "./SupabaseUi.tsx";
import { useVercelOverview, VercelBody } from "./VercelUi.tsx";
import { Button, Dialog, ErrorLine, ICON, ICON_SM, IconButton, InfoTip, Menu, Spinner, STROKE, Tip, useToast } from "./kit.tsx";

// The project's shared files live in the right column of a project's chats, as the approved hi-fi boards draw it
// ("Hi-fi · light": a 320 px column, the files card on top, the notes card under it). The chat header's right-panel button
// shows and hides the column. Every member can browse the files (read only; AI changes are proposals their owner
// approves, see Changes.tsx). Several people share here, each from their own computer: every item has a presence dot for
// its owner's app, the host and admins share directly, a member's request waits for the host or an admin, and the owner
// (or the host or an admin) can remove an item. In the desktop app a folder or file dragged onto the card starts sharing it.

const messageOf = (e: unknown, fallback = "Something went wrong.") => (e instanceof Error ? e.message : fallback);

const sizeLabel = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Hovering must rest this long before a tooltip shows, so one that is only passed over stays quiet. */
const TIP_DELAY_MS = 600;
/** The list of git changes under the Files card is switched off until its design is settled (the AI's git tools are unaffected). */
const SHOW_GIT_PANEL = false;

const REFUSED: Record<string, string> = {
  too_many: `A project can share up to ${FOLDER_LIMITS.items} folders and files in all. Remove one first.`,
  too_many_requests: "You already have 5 requests waiting for approval. Wait for an answer or cancel one.",
  not_found: "You're no longer in this project, so nothing you share here is served.",
  invalid_items: "Something you share here can't be shared.",
};

/**
 * Brings the right column back. As with the left panel, the toggle sits on the panel while it is open and moves into
 * the chat header (on the right) once it is collapsed. On a small screen the column is a drawer, so the header keeps it.
 */
export function RightPanelToggle() {
  const { folderPanel } = useApp();
  if (folderPanel.open && !folderPanel.drawer) return null;
  return (
    <IconButton label="Show files" onClick={folderPanel.toggle} aria-expanded={folderPanel.open}>
      <PanelRightOpen size={ICON} strokeWidth={STROKE} />
    </IconButton>
  );
}

/** The right column of a project's chats: the files card on top, the notes card under it. */
export function RightColumn({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const { me } = useApp();
  const split = useSplit(me.id);
  const column = useRef<HTMLDivElement>(null);
  // The height the two cards share: the column without the gap between them.
  const available = () => (column.current?.clientHeight ?? 0) - (column.current ? parseFloat(getComputedStyle(column.current).rowGap) || 0 : 0);
  return (
    <div className="right-column" ref={column} style={{ "--files-grow": split.share, "--notes-grow": 1 - split.share } as React.CSSProperties}>
      <FolderCard project={project} onClose={onClose} />
      <SplitResizer share={split.share} available={available} onChange={split.set} />
      <NotesCard project={project} />
    </div>
  );
}

/** Whether something being dragged over the window carries files from the file system. */
const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

function FolderCard({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const { me } = useApp();
  const shares = useProjectShares(project.id);
  const bridge = folderBridge();
  const canShare = !!bridge && typeof bridge.pick === "function" && typeof bridge.remove === "function";
  const mine = (shares.data ?? []).filter((s) => s.owner_id === me.id);
  const share = useShare(project, bridge, mine.length > 0);

  // The Scripts tab: only in the desktop app, for a person who shares a folder from this computer (the scripts run there),
  // and only when that folder has scripts to run.
  const local = useLocalFolder(project.id);
  const scriptsApi = bridge?.scripts ?? null;
  const canScripts = !!scriptsApi && !!local?.items.some((i) => i.kind === "dir" && i.status === "active");
  const scripts = useScripts(project.id, canScripts);
  const hasScripts = canScripts && showScriptsTab(scripts.info);
  // The Supabase tab: for everyone in a project linked to a Supabase project, once they have Supabase set up themselves.
  const sup = useSupabaseState(project.id);
  const hasSupabase = !!sup.state && showSupabaseTab(sup.state);
  // The Vercel tab: the same, for a project linked to a Vercel project. Its first read also gives the dot on the tab.
  const ver = useVercelState(project.id);
  const hasVercel = !!ver.state && showVercelTab(ver.state);
  const [verVersion, setVerVersion] = useState(0);
  const verOverview = useVercelOverview(project.id, hasVercel && ver.state?.mine.state === "ready", verVersion);
  const shown: FilesTab[] = ["files", ...(hasScripts ? (["scripts"] as const) : []), ...(hasSupabase ? (["supabase"] as const) : []), ...(hasVercel ? (["vercel"] as const) : [])];
  type Tab = FilesTab;
  const [tabPref, setTabPref] = useState<string>(() => readPref<string>(PREF.filesTab(me.id), "files"));
  const tab: Tab = pickedTab(tabPref, shown);
  const pickTab = (next: Tab) => {
    setTabPref(next);
    writePref(PREF.filesTab(me.id), next);
  };
  const crashUnseen = tab === "scripts" && !!scripts.info?.runs.some((r) => r.unseen);
  useEffect(() => {
    if (crashUnseen) void scriptsApi?.seen(project.id).catch(() => undefined);
  }, [crashUnseen, scriptsApi, project.id]);

  // Dragging a folder or file from the file system onto the card starts sharing it (the desktop app only: a browser never gets paths).
  const canDrop = canShare && typeof bridge?.onDrop === "function" && typeof bridge.dropCommit === "function";
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const dropped = useRef(share.onDropped);
  dropped.current = share.onDropped;
  useEffect(() => {
    if (!canDrop) return;
    return bridge!.onDrop!((projectId, d) => projectId === project.id && dropped.current(d));
  }, [canDrop, bridge, project.id]);
  const dragProps = canDrop
    ? {
        "data-files-drop": project.id,
        onDragEnter: (e: React.DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          depth.current++;
          setOver(true);
        },
        onDragOver: (e: React.DragEvent) => hasFiles(e) && e.preventDefault(),
        onDragLeave: (e: React.DragEvent) => {
          if (!hasFiles(e)) return;
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        },
        onDrop: () => {
          depth.current = 0;
          setOver(false);
        },
      }
    : {};

  if (shares.data === undefined) return <section className="side-card folder-card"><div className="folder-loading"><Spinner /></div></section>;
  const empty = shares.data.length === 0;
  const overlay = over && <DropOverlay />;

  if (empty && !hasSupabase && !hasVercel) {
    return (
      <section className="side-card folder-card empty" aria-label="Files" {...dragProps}>
        <span className="folder-empty-close">
          <IconButton label="Hide files" onClick={onClose} className="sm">
            <PanelRightClose size={ICON_SM} strokeWidth={STROKE} />
          </IconButton>
        </span>
        <Folder size={22} strokeWidth={1.75} aria-hidden />
        <div className="strong">{canDrop ? "Drop a folder or files here" : "Files"}</div>
        <p className="small muted">
          {canShare
            ? project.my_role === "member"
              ? `Share folders or files from your computer. The host or an admin approves them first, then everyone in ${project.name} can read them and the AI can use them in project chats. Nothing is uploaded.`
              : `Share folders or files from your computer. Everyone in ${project.name} can read them, and the AI can use them in project chats. Members can only read; nothing is uploaded.`
            : bridge
              ? "Sharing needs a newer version of the desktop app. Restart it to update."
              : `Nothing is shared in ${project.name} yet. Folders and files are shared from your computer, so this takes the desktop app. Open ${project.name} there to share.`}
        </p>
        {canShare && <ShareMenu share={share} primary />}
        {share.error && <ErrorLine>{share.error}</ErrorLine>}
        {share.dialog}
        {overlay}
      </section>
    );
  }

  return (
    <section className="side-card folder-card" aria-label="Files" {...dragProps}>
      <header className="side-card-head">
        {hasScripts || hasSupabase || hasVercel ? (
          <span className="side-card-title grow">
            <span className="notes-filter files-tabs" role="tablist" aria-label="Files, scripts and services">
              <button type="button" role="tab" aria-selected={tab === "files"} className={`notes-tab ${tab === "files" ? "on" : ""}`} onClick={() => pickTab("files")}>
                Files
              </button>
              {hasScripts && (
                <button type="button" role="tab" aria-selected={tab === "scripts"} className={`notes-tab ${tab === "scripts" ? "on" : ""}`} onClick={() => pickTab("scripts")}>
                  Scripts
                  <ScriptsDot info={scripts.info} />
                </button>
              )}
              {hasSupabase && (
                <button type="button" role="tab" aria-label="Supabase" title="Supabase" aria-selected={tab === "supabase"} className={`notes-tab ${tab === "supabase" ? "on" : ""}`} onClick={() => pickTab("supabase")}>
                  <Database size={ICON_SM} strokeWidth={STROKE} aria-hidden />
                  {tabShowsName("supabase", tab, shown) && <span className="tab-name">Supabase</span>}
                </button>
              )}
              {hasVercel && (
                <button type="button" role="tab" aria-label="Vercel" title="Vercel" aria-selected={tab === "vercel"} className={`notes-tab ${tab === "vercel" ? "on" : ""}`} onClick={() => pickTab("vercel")}>
                  <Triangle size={ICON_SM} strokeWidth={STROKE} fill="currentColor" aria-hidden />
                  {tabShowsName("vercel", tab, shown) && <span className="tab-name">Vercel</span>}
                  <VercelDot overview={verOverview.data} />
                </button>
              )}
            </span>
            {tab === "files" && <FolderInfo />}
          </span>
        ) : (
          <>
            <Folder size={ICON_SM} strokeWidth={STROKE} aria-hidden />
            <span className="side-card-title grow">
              <b className="truncate">Files</b>
              <FolderInfo />
            </span>
          </>
        )}
        {canShare && tab === "files" && <ShareMenu share={share} />}
        <IconButton label="Hide files" onClick={onClose} className="sm">
          <PanelRightClose size={ICON_SM} strokeWidth={STROKE} />
        </IconButton>
      </header>
      {tab === "scripts" && scriptsApi ? (
        <ScriptsBody project={project} info={scripts.info} version={scripts.version} execOn={local?.caps?.exec === true} bridge={scriptsApi} />
      ) : tab === "supabase" ? (
        <SupabaseBody project={project} sup={sup} />
      ) : tab === "vercel" ? (
        <VercelBody project={project} vh={ver} overview={verOverview} onRefresh={() => setVerVersion((n) => n + 1)} />
      ) : empty ? (
        <div className="side-card-body">
          <p className="small muted">Nothing is shared in {project.name} yet. Folders and files are shared from your computer, in the desktop app.</p>
        </div>
      ) : (
        <FolderBody project={project} rows={shares.data} share={share} />
      )}
      {overlay}
    </section>
  );
}

/** A small dot on the Vercel tab: red when the latest production build failed, yellow while one is building. */
function VercelDot({ overview }: { overview: Parameters<typeof vercelTabDot>[0] }) {
  const dot = vercelTabDot(overview);
  if (!dot) return null;
  return <span className={`mdot tab-dot ${dot}`} role="img" aria-label={dot === "failed" ? "The latest production build failed" : "A build is running"} />;
}

/** A small dot on the Scripts tab: green while a script runs, red for a crash that has not been looked at (also when the Files tab is open). */
function ScriptsDot({ info }: { info: Parameters<typeof scriptsDot>[0] }) {
  const dot = scriptsDot(info);
  if (!dot) return null;
  return <span className={`mdot tab-dot ${dot}`} role="img" aria-label={dot === "ready" ? "A script is running" : "A script crashed"} />;
}

/** The single Share button: it opens a small menu to share a folder or files. */
function ShareMenu({ share, primary }: { share: ReturnType<typeof useShare>; primary?: boolean }) {
  return (
    <Menu
      label="Share from this computer"
      align="end"
      items={[
        { label: "Share folder", icon: <FolderPlus size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => share.start("folder") },
        { label: "Share files", icon: <FilePlus size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => share.start("files") },
      ]}
      trigger={({ toggle, open }) => (
        <Button size="sm" variant={primary ? "primary" : "secondary"} onClick={toggle} busy={share.busy} aria-haspopup="menu" aria-expanded={open}>
          <Plus size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Share
        </Button>
      )}
    />
  );
}

function DropOverlay() {
  return (
    <div className="folder-drop" aria-hidden>
      <Upload size={24} strokeWidth={STROKE} />
      <b>Drop to share</b>
      <span>Folders and files from your computer</span>
    </div>
  );
}

/** What sharing means, behind an info icon in the card header. */
function FolderInfo() {
  return (
    <InfoTip label="About shared files">
      <ul className="info-tip-list">
        <li>Members can only read the files. The AI can propose changes only if the person who shares them allows it, and every change needs their approval.</li>
        <li>A member's request to share needs the host's or an admin's approval first.</li>
        <li>Never shared: .env files, keys, .git, node_modules, build folders and links.</li>
        <li>Binary files and files over {FOLDER_LIMITS.fileBytes / 1024 / 1024} MB can't be opened.</li>
        <li>Text the AI reads goes to the AI provider of the person who asked.</li>
      </ul>
    </InfoTip>
  );
}

/**
 * Adding folders or files, from the picker or by dropping them: the "who can see this" notice first when this person
 * hasn't shared in the project yet, then the native dialog or the drop is committed in the app, which tells the server.
 * The server names the items and, for a member, asks the host and admins.
 */
function useShare(project: ProjectSummary, bridge: FolderBridge | null, shared: boolean) {
  const toast = useToast();
  const [notice, setNotice] = useState<"folder" | "files" | "drop" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsApproval = project.my_role === "member";

  function report(r: PickResult, kind: "folder" | "files" | "drop") {
    if (!r.ok) {
      if (r.error) setError(r.error);
      return false;
    }
    if (r.skipped.length) toast.push(`Not shared: ${r.skipped.join(", ")}. Secrets like .env files and keys are never shared.`, "error");
    else toast.push(needsApproval ? "Sent to the host and admins for approval" : kind === "folder" ? "Folder shared" : kind === "files" ? "Files shared" : "Shared");
    return true;
  }

  async function run(kind: "folder" | "files" | "drop") {
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      if (typeof bridge.remove !== "function") throw new Error("Restart the desktop app to share files.");
      const r = kind === "drop" ? await bridge.dropCommit!(project.id) : await bridge.pick(project.id, kind); // a native dialog, or what was dropped: the page never sees a path
      if (report(r, kind)) setNotice(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const start = (kind: "folder" | "files") => (shared ? void run(kind) : setNotice(kind));
  const onDropped = (d: Dropped) => {
    if (!d.ok) return void toast.push(d.error, "error");
    if (shared) void run("drop");
    else setNotice("drop");
  };
  const cancel = () => {
    if (notice === "drop") void bridge?.dropCancel?.(project.id);
    setNotice(null);
  };

  const dialog = notice ? (
    <Dialog onClose={cancel} width={480} label={shareFolderNotice(project.name, needsApproval).title}>
      <NoticeBody
        {...shareFolderNotice(project.name, needsApproval)}
        confirmLabel={notice === "folder" ? "Choose a folder" : notice === "files" ? "Choose files" : "Share them"}
        cancelLabel="Cancel"
        busy={busy}
        error={error}
        onConfirm={() => void run(notice)}
        onCancel={cancel}
      />
    </Dialog>
  ) : null;
  return { start, onDropped, dialog, error: notice ? null : error, busy };
}

const AI_EDIT_TEXT: Partial<Record<AiEditState, string>> = {
  off: "The AI can read these files but not change them. Whoever shares a folder can allow edits in Project settings, in the desktop app.",
  offline: "AI edits are paused: the app of whoever shares is closed. Edits need it running.",
};

/** One line under the files saying whether the AI may propose edits, so a read-only AI has a visible reason. Re-checked while the card is open. */
function AiEditStatus({ projectId, onlineKey }: { projectId: string; onlineKey: string }) {
  const [state, setState] = useState<AiEditState | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.folderAi(projectId).then((r) => live && setState(r.edit), () => live && setState(null));
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [projectId, onlineKey]);
  if (!state || !AI_EDIT_TEXT[state]) return null;
  return (
    <div className={`ai-edit-status small muted ${state}`} role="status">
      {AI_EDIT_TEXT[state]}
    </div>
  );
}

function FolderBody({ project, rows, share }: { project: ProjectSummary; rows: ShareRow[]; share: ReturnType<typeof useShare> }) {
  const { me } = useApp();
  const toast = useToast();
  const bridge = folderBridge();
  const local = useLocalFolder(project.id);
  const [error, setError] = useState<string | null>(null);
  const decides = project.my_role === "host" || project.my_role === "admin";

  // The server may refuse what this computer reported (too many items in the project): the app says so over its bridge.
  useEffect(() => bridge?.onItemsError?.((projectId, code) => projectId === project.id && toast.push(REFUSED[code] ?? "Something you share here couldn't be shared.", "error")), [bridge, project.id, toast]);

  /** Stops sharing one item: this computer drops it first when it is the owner's, then the server's list (it ignores one that is already gone). */
  async function remove(row: ShareRow) {
    setError(null);
    try {
      if (row.owner_id === me.id) await bridge?.remove?.(project.id, row.name);
      await api.removeShare(project.id, row.id).catch((e: unknown) => {
        if (!(e instanceof ApiRequestError && e.status === 404)) throw e;
      });
      notifyChanged();
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function decide(row: ShareRow, approve: boolean) {
    setError(null);
    try {
      await api.decideShare(project.id, row.id, approve);
      notifyChanged();
    } catch (e) {
      setError(messageOf(e));
    }
  }

  const requests = decides ? rows.filter((r) => r.status === "pending" && r.owner_id !== me.id) : [];
  // What the project reads: approved items, plus this person's own requests (shown as waiting).
  const listed = rows.filter((r) => r.status === "active" || r.owner_id === me.id);
  const refused = local?.error ? (REFUSED[local.error] ?? "The server didn't accept what this computer shares here.") : null;
  const anyOnline = rows.some((r) => r.status === "active" && r.online);

  return (
    <div className="side-card-body">
      {requests.map((r) => (
        <div className="share-request" key={r.id} role="group" aria-label={`Request from ${r.owner_name}`}>
          <div className="t">{r.owner_name} wants to share {r.kind === "dir" ? "a folder" : "a file"}</div>
          <div className="s small">{r.name}. Everyone here and the AI could read {r.kind === "dir" ? "it" : "it"}.</div>
          <div className="row">
            <Button size="sm" onClick={() => void decide(r, true)}>
              <Check size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Approve
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void decide(r, false)}>
              Decline
            </Button>
          </div>
        </div>
      ))}
      {refused && (
        <div className="plan-warn" role="status">
          <TriangleAlert size={ICON} strokeWidth={STROKE} aria-hidden />
          <div className="small">{refused}</div>
        </div>
      )}
      {/* Keyed by the items: adding or removing one starts browsing from the top again. */}
      <FolderBrowser key={listed.map((r) => r.id).join(",")} projectId={project.id} rows={listed} meId={me.id} canRemoveOthers={decides} onRemove={(row) => void remove(row)} />
      {listed.some((r) => r.status === "active") && <AiEditStatus projectId={project.id} onlineKey={listed.map((r) => `${r.id}:${r.online}`).join(",")} />}
      {SHOW_GIT_PANEL && anyOnline && <GitChanges key={`git-${listed.map((r) => r.id).join(",")}`} projectId={project.id} />}
      {(error || share.error) && <ErrorLine>{error ?? share.error}</ErrorLine>}
      {share.dialog}
    </div>
  );
}

/** The folder icon of an item with a small presence dot, like the one on a person's avatar: is its owner's app running? A hover that rests a moment explains it. */
function ItemIcon({ row, mine }: { row: ShareRow; mine: boolean }) {
  const waiting = row.status === "pending";
  const text = waiting
    ? "Waiting for approval. Nobody else can see it yet."
    : row.online
      ? `Online: ${mine ? "your" : `${row.owner_name}'s`} app is running, so this can be read.`
      : `Offline: ${mine ? "your" : `${row.owner_name}'s`} app is closed, so this can't be read right now.`;
  return (
    <Tip text={text} delayMs={TIP_DELAY_MS} focusable={false} className="row-ico">
      {row.kind === "dir" ? <FolderOpen size={ICON_SM} strokeWidth={STROKE} aria-hidden /> : <File size={ICON_SM} strokeWidth={STROKE} aria-hidden />}
      <span className={`presence ${!waiting && row.online ? "on" : ""}`} aria-label={waiting ? "Waiting for approval" : row.online ? "Online" : "Offline"} />
    </Tip>
  );
}

/** Browse the shared files, one level at a time, and read a file. The top level is the list of items; below it all of it goes through the server to the owner's app. */
function FolderBrowser({ projectId, rows, meId, canRemoveOthers, onRemove }: { projectId: string; rows: ShareRow[]; meId: string; canRemoveOthers: boolean; onRemove: (row: ShareRow) => void }) {
  const { files } = useApp();
  const [path, setPath] = useState("");
  const [dir, setDir] = useState<FolderListResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDir(null);
    setError(null);
    if (path === "") return; // the top level is the list of items, from the database
    let live = true;
    api.folderList(projectId, path).then(
      (r) => live && setDir(r),
      (e: unknown) => live && setError(messageOf(e)),
    );
    return () => {
      live = false;
    };
  }, [projectId, path]);

  const parts = path ? path.split("/") : [];
  const join = (name: string) => (path ? `${path}/${name}` : name);
  const top = [...rows].sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  return (
    <div className="folder-browser">
      {parts.length > 0 && (
        <nav className="folder-crumbs" aria-label="Folder path">
          <IconButton label="Back to the top" className="sm" onClick={() => setPath("")}>
            <Home size={ICON_SM} strokeWidth={STROKE} />
          </IconButton>
          {parts.map((p, i) => (
            <span key={`${i}-${p}`} className="row">
              {i > 0 && <span className="muted" aria-hidden>/</span>}
              <button type="button" onClick={() => setPath(parts.slice(0, i + 1).join("/"))} className="truncate">
                {p}
              </button>
            </span>
          ))}
        </nav>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
      {path === "" ? (
        <ul className="folder-list">
          {top.map((row) => {
            const mine = row.owner_id === meId;
            const waiting = row.status === "pending";
            const removable = mine || canRemoveOthers;
            return (
              <li key={row.id} className={removable ? "has-menu" : undefined}>
                <button type="button" disabled={waiting} aria-current={row.kind === "file" && files.path === row.name ? "true" : undefined} onClick={() => (row.kind === "dir" ? setPath(row.name) : files.open(row.name))}>
                  <ItemIcon row={row} mine={mine} />
                  <span className="grow truncate">{row.name}</span>
                  {waiting ? <span className="small muted">Waiting for approval</span> : !mine && <span className="small muted truncate owner">{row.owner_name}</span>}
                </button>
                {removable && <RemoveMenu row={row} mine={mine} placement={top.length > 3 && row === top.at(-1) ? "above" : "below"} onRemove={onRemove} />}
              </li>
            );
          })}
        </ul>
      ) : dir ? (
        <ul className="folder-list">
          {dir.entries.length === 0 && <li className="small muted pad">This folder is empty.</li>}
          {dir.entries.map((e) => (
            <li key={e.name}>
              <button type="button" aria-current={e.type === "file" && files.path === join(e.name) ? "true" : undefined} onClick={() => (e.type === "dir" ? setPath(join(e.name)) : files.open(join(e.name)))}>
                {e.type === "dir" ? <FolderOpen size={ICON_SM} strokeWidth={STROKE} aria-hidden /> : <File size={ICON_SM} strokeWidth={STROKE} aria-hidden />}
                <span className="grow truncate">{e.name}</span>
                {e.type === "file" && e.size !== undefined && <span className="small muted">{sizeLabel(e.size)}</span>}
              </button>
            </li>
          ))}
          {dir.truncated && <li className="small muted pad">Only the first {FOLDER_LIMITS.listEntries} entries are shown.</li>}
        </ul>
      ) : !error ? (
        <div className="folder-loading small"><Spinner /> Loading…</div>
      ) : null}
    </div>
  );
}

/** The three-dot menu of an item: Remove (or Cancel request) only stops sharing it. */
function RemoveMenu({ row, mine, placement, onRemove }: { row: ShareRow; mine: boolean; placement: "above" | "below"; onRemove: (row: ShareRow) => void }) {
  const waiting = row.status === "pending";
  return (
    <Menu
      label={`Options for ${row.name}`}
      align="end"
      placement={placement}
      className="folder-row-menu"
      portal
      items={[
        {
          label: waiting ? "Cancel request" : "Remove",
          hint: mine ? "Stops sharing it. Nothing is deleted from your computer." : `Stops ${row.owner_name} sharing it. Nothing is deleted from their computer.`,
          icon: <X size={ICON_SM} strokeWidth={STROKE} />,
          onSelect: () => onRemove(row),
        },
      ]}
      trigger={({ toggle, open }) => (
        <Tip text="Options" focusable={false}>
          <button type="button" className={`icon-btn row-more folder-row-more ${open ? "open" : ""}`} aria-label={`Options for ${row.name}`} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
            <MoreHorizontal size={ICON_SM} strokeWidth={STROKE} />
          </button>
        </Tip>
      )}
    />
  );
}

const GIT_LETTER: Record<string, string> = { M: "M", A: "A", D: "D", R: "R", C: "C", "?": "new", U: "!" };

/** What changed in the shared folder's git repository. Shown only when the host switched git on and the folder is a repository. */
function GitChanges({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  /** Counts successful status loads, so an open diff is fetched again with them. */
  const [loads, setLoads] = useState(0);

  const load = useCallback(() => {
    api.gitStatus(projectId).then(
      (r) => {
        setStatus(r);
        setLoads((n) => n + 1);
        setError(null);
        setOff(false);
      },
      (e: unknown) => {
        // Not switched on, not a repository, several folders shared, or a repository git is not used on: no section at all.
        if (e instanceof ApiRequestError && ["git_off", "no_repo", "git_unsafe", "disabled", "bad_request"].includes(e.code ?? "")) setOff(true);
        else setError(messageOf(e));
      },
    );
  }, [projectId]);

  // Kept current without a button: every few seconds while the window is visible, at once when it comes back into
  // view, and whenever something happens in the project (an answer that committed or edited arrives as a message).
  useEffect(() => {
    load();
    const visible = () => document.visibilityState === "visible";
    const t = setInterval(() => visible() && load(), 5_000);
    const onShow = () => visible() && load();
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", onShow);
    const off = onChanged(load);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("focus", onShow);
      off();
    };
  }, [load]);

  useEffect(() => setDiff(null), [projectId, open]);
  useEffect(() => {
    if (open === null) return;
    let live = true;
    api.gitDiff(projectId, open, "head").then(
      (r) => live && setDiff(r.text),
      (e: unknown) => live && setDiff(messageOf(e)),
    );
    return () => {
      live = false;
    };
  }, [projectId, open, loads]);

  if (off || (!status && !error)) return null;
  const files = status?.files ?? [];
  return (
    <section className="git-changes" aria-label="Git changes">
      <div className="row">
        <GitBranch size={ICON_SM} strokeWidth={STROKE} aria-hidden />
        <span className="small strong grow truncate">{status?.branch ?? "No branch"}</span>
        <span className="small muted">{files.length === 0 ? "clean" : `${files.length}${status?.truncated ? "+" : ""} changed`}</span>
        <IconButton label="Refresh git changes" className="sm" onClick={load}>
          <RefreshCw size={ICON_SM} strokeWidth={STROKE} />
        </IconButton>
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
      {files.length > 0 && (
        <ul className="git-files">
          {files.map((f) => {
            const code = f.worktree !== " " ? f.worktree : f.index;
            const untracked = f.index === "?" && f.worktree === "?";
            return (
              <li key={f.path}>
                <button type="button" onClick={() => setOpen(open === f.path ? null : f.path)} aria-expanded={open === f.path}>
                  <span className={`git-letter ${code === "?" ? "new" : code}`}>{GIT_LETTER[code] ?? code}</span>
                  <span className="grow truncate">{f.path}</span>
                  {f.index !== " " && f.index !== "?" && <span className="small muted">staged</span>}
                </button>
                {open === f.path && (untracked ? <p className="small muted pad">New file, not tracked yet.</p> : diff === null ? <div className="folder-loading small"><Spinner /> Loading…</div> : <DiffView diff={diff} />)}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
