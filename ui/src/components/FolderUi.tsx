import { FOLDER_LIMITS, type FolderListResult, type FolderReadResult, type GitStatusResult, type ProjectFolder, type ProjectSummary } from "@mc/shared";
import { ArrowLeft, File, FilePlus, Folder, FolderOpen, FolderPlus, GitBranch, Home, MoreHorizontal, PanelRightClose, PanelRightOpen, Plus, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, ApiRequestError } from "../api.ts";
import { notifyChanged, onChanged, useApp } from "../data.tsx";
import { folderBridge, useLocalFolder, useProjectFolder, type FolderBridge } from "../lib/folder.ts";
import { DiffView } from "./Changes.tsx";
import { NoticeBody, shareFolderNotice } from "./Notice.tsx";
import { Button, Dialog, ErrorLine, ICON, ICON_SM, IconButton, InfoTip, Menu, Spinner, STROKE, Tip, useToast } from "./kit.tsx";

// The project's shared folder lives in the right column of a project's chats, as the approved hi-fi boards draw it
// ("Hi-fi · light": a 320 px column, the shared folder card on top, Notes under it later). The chat header's
// right-panel button shows and hides the column. The card shows whether the host's app is serving the files, lets
// any member browse them (read only; AI changes are proposals the host approves, see Changes.tsx), and lets the host add folders and files, remove them, or stop sharing.

const messageOf = (e: unknown, fallback = "Something went wrong.") => (e instanceof Error ? e.message : fallback);

const sizeLabel = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function StatusDot({ on }: { on: boolean }) {
  return <span className={`status-dot ${on ? "on" : ""}`} aria-hidden />;
}

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

/** The right column of a project's chats. Notes will sit under the shared folder card. */
export function RightColumn({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  return (
    <div className="right-column">
      <FolderCard project={project} onClose={onClose} />
    </div>
  );
}

function FolderCard({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const folder = useProjectFolder(project.id);
  const host = project.my_role === "host";
  const bridge = folderBridge();
  if (folder.data === undefined) return <section className="side-card folder-card"><div className="folder-loading"><Spinner /></div></section>;
  if (folder.data === null) return <FolderEmpty project={project} host={host} bridge={bridge} onClose={onClose} />;
  return (
    <section className="side-card folder-card" aria-label="Files">
      <header className="side-card-head">
        <Folder size={ICON_SM} strokeWidth={STROKE} aria-hidden />
        <span className="side-card-title grow">
          <b className="truncate">Files</b>
          <FolderInfo />
        </span>
        <Tip
          className="side-card-status small muted"
          text={folder.data.online ? "Online: the host's app is running, so the files can be read." : "Offline: the host's app is closed, so the files can't be read right now."}
        >
          <StatusDot on={folder.data.online} />
          {folder.data.online ? "Online" : "Offline"}
        </Tip>
        <IconButton label="Hide files" onClick={onClose} className="sm">
          <PanelRightClose size={ICON_SM} strokeWidth={STROKE} />
        </IconButton>
      </header>
      <FolderBody project={project} folder={folder.data} host={host} bridge={bridge} />
    </section>
  );
}

/** What sharing means, behind an info icon in the card header. */
function FolderInfo() {
  return (
    <InfoTip label="About shared files">
      <ul className="info-tip-list">
        <li>Members can only read the files. The AI can propose changes only if the host allows it, and every change needs the host's approval.</li>
        <li>Never shared: .env files, keys, .git, node_modules, build folders and links.</li>
        <li>Binary files and files over {FOLDER_LIMITS.fileBytes / 1024 / 1024} MB can't be opened.</li>
        <li>Text the AI reads goes to the AI provider of the person who asked.</li>
      </ul>
    </InfoTip>
  );
}

/** Nothing shared yet: the dashed placeholder card of the approved board, with the host's way to share. */
function FolderEmpty({ project, host, bridge, onClose }: { project: ProjectSummary; host: boolean; bridge: FolderBridge | null; onClose: () => void }) {
  const share = useShare(project, bridge, false);
  return (
    <section className="side-card folder-card empty" aria-label="Files">
      <span className="folder-empty-close">
        <IconButton label="Hide files" onClick={onClose} className="sm">
          <PanelRightClose size={ICON_SM} strokeWidth={STROKE} />
        </IconButton>
      </span>
      <Folder size={22} strokeWidth={1.75} aria-hidden />
      <div className="strong">Files</div>
      <p className="small muted">
        {host
          ? bridge
            ? `Share folders or files from your computer. Everyone in ${project.name} can read them, and the AI can use them in project chats. Members can only read; nothing is uploaded.`
            : `Files are shared from your computer, so this takes the desktop app. Open ${project.name} there to share folders or files.`
          : `Nothing is shared in ${project.name} yet. The project host can share folders or files from the desktop app.`}
      </p>
      {host && bridge && (
        <div className="row">
          <Button size="sm" variant="primary" onClick={() => share.start("folder")}>
            <FolderPlus size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Add folder
          </Button>
          <Button size="sm" onClick={() => share.start("files")}>
            <FilePlus size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Add files
          </Button>
        </div>
      )}
      {share.error && <ErrorLine>{share.error}</ErrorLine>}
      {share.dialog}
    </section>
  );
}

/**
 * Adding folders or files: the "who can see this" notice first when nothing is shared yet, then the native dialog,
 * then the new name is registered with the server and the app starts serving.
 */
function useShare(project: ProjectSummary, bridge: FolderBridge | null, shared: boolean) {
  const toast = useToast();
  const [notice, setNotice] = useState<"folder" | "files" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(kind: "folder" | "files") {
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      if (typeof bridge.remove !== "function") throw new Error("Restart the desktop app to share files.");
      const picked = await bridge.pick(project.id, kind); // a native dialog: the page never sees a path
      if (!picked.ok) {
        if (picked.error) setError(picked.error);
        return;
      }
      await api.linkFolder(project.id, picked.name);
      await bridge.connect(project.id);
      notifyChanged();
      setNotice(null);
      if (picked.skipped.length) toast.push(`Not shared: ${picked.skipped.join(", ")}. Secrets like .env files and keys are never shared.`, "error");
      else toast.push(kind === "folder" ? "Folder shared" : "Files shared");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const start = (kind: "folder" | "files") => (shared ? void pick(kind) : setNotice(kind));
  const dialog = notice ? (
    <Dialog onClose={() => setNotice(null)} width={480} label={shareFolderNotice(project.name).title}>
      <NoticeBody
        {...shareFolderNotice(project.name)}
        confirmLabel={notice === "folder" ? "Choose a folder" : "Choose files"}
        cancelLabel="Cancel"
        busy={busy}
        error={error}
        onConfirm={() => void pick(notice)}
        onCancel={() => setNotice(null)}
      />
    </Dialog>
  ) : null;
  return { start, dialog, error: notice ? null : error, busy };
}

function FolderBody({ project, folder, host, bridge }: { project: ProjectSummary; folder: ProjectFolder; host: boolean; bridge: FolderBridge | null }) {
  const local = useLocalFolder(host ? project.id : null);
  const share = useShare(project, bridge, true);
  const [error, setError] = useState<string | null>(null);

  async function remove(name: string) {
    if (!bridge) return;
    setError(null);
    try {
      const next = await bridge.remove(project.id, name);
      if (next.name === null) await api.unlinkFolder(project.id);
      else {
        await api.linkFolder(project.id, next.name);
        await bridge.connect(project.id);
      }
      notifyChanged();
    } catch (e) {
      setError(messageOf(e));
    }
  }

  const manage = host && !!bridge && typeof bridge.remove === "function";
  // Several items (or one file) are listed at the top under their own names, and each gets a Remove menu. A single folder is shown from the inside, so it gets a row of its own above the list.
  const itemsHere = manage && local?.linked ? local.items : [];
  const removable = itemsHere.length > 1 || (itemsHere.length === 1 && itemsHere[0]!.kind === "file") ? new Set(itemsHere.map((i) => i.name)) : null;
  const lone = itemsHere.length === 1 && itemsHere[0]!.kind === "dir" ? itemsHere[0]!.name : null;
  const notHere = host && !!bridge && !!local && !local.linked;
  const refused = host && !!bridge && local?.linked && local.state === "rejected";

  return (
    <div className="side-card-body">
      {!folder.online && (
        <p className="small muted">The host's desktop app isn't connected, so the files can't be read right now. The AI will say they are unavailable.</p>
      )}
      {notHere && (
        <div className="plan-warn" role="status">
          <TriangleAlert size={ICON} strokeWidth={STROKE} aria-hidden />
          <div className="small">This computer isn't serving these files. They were shared from another computer, or the link was lost. Add them again here to bring them online.</div>
        </div>
      )}
      {refused && (
        <div className="plan-warn" role="status">
          <TriangleAlert size={ICON} strokeWidth={STROKE} aria-hidden />
          <div className="small">The server doesn't accept this computer as the host. Add the files again to share them.</div>
        </div>
      )}
      {manage && (
        <div className="side-card-actions">
          <div className="grow" />
          <Menu
            label="Share from this computer"
            items={[
              { label: "Share folder", icon: <FolderPlus size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => share.start("folder") },
              { label: "Share files", icon: <FilePlus size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => share.start("files") },
            ]}
            trigger={({ toggle, open }) => (
              <Button size="sm" onClick={toggle} busy={share.busy} aria-haspopup="menu" aria-expanded={open}>
                <Plus size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Share
              </Button>
            )}
          />
        </div>
      )}
      {/* Keyed by when it was last shared: adding or removing an item starts browsing from the top again. */}
      {folder.online ? <FolderBrowser key={folder.linked_at} projectId={project.id} removable={removable} lone={lone} onRemove={(name) => void remove(name)} /> : <div className="grow" />}
      {folder.online && <GitChanges key={`git-${folder.linked_at}`} projectId={project.id} />}
      {(error || share.error) && <ErrorLine>{error ?? share.error}</ErrorLine>}
      {share.dialog}
    </div>
  );
}

/** Browse the shared folder, one level at a time, and read a file. All of it goes through the server to the host's app. */
function FolderBrowser({ projectId, removable, lone, onRemove }: { projectId: string; removable: Set<string> | null; lone: string | null; onRemove: (name: string) => void }) {
  const [path, setPath] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const [dir, setDir] = useState<FolderListResult | null>(null);
  const [text, setText] = useState<FolderReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDir(null);
    setError(null);
    api.folderList(projectId, path).then(
      (r) => live && setDir(r),
      (e: unknown) => live && setError(messageOf(e)),
    );
    return () => {
      live = false;
    };
  }, [projectId, path]);

  useEffect(() => {
    setText(null);
    if (file === null) return;
    let live = true;
    setError(null);
    api.folderRead(projectId, file).then(
      (r) => live && setText(r),
      (e: unknown) => live && setError(messageOf(e)),
    );
    return () => {
      live = false;
    };
  }, [projectId, file]);

  const parts = path ? path.split("/") : [];
  const join = (name: string) => (path ? `${path}/${name}` : name);

  return (
    <div className="folder-browser">
      {parts.length > 0 && (
        <nav className="folder-crumbs" aria-label="Folder path">
          <IconButton label="Back to the top" className="sm" onClick={() => { setPath(""); setFile(null); }}>
            <Home size={ICON_SM} strokeWidth={STROKE} />
          </IconButton>
          {parts.map((p, i) => (
            <span key={`${i}-${p}`} className="row">
              {i > 0 && <span className="muted" aria-hidden>/</span>}
              <button type="button" onClick={() => { setPath(parts.slice(0, i + 1).join("/")); setFile(null); }} className="truncate">
                {p}
              </button>
            </span>
          ))}
        </nav>
      )}
      {lone && path === "" && file === null && (
        <div className="folder-root-row">
          <FolderOpen size={ICON_SM} strokeWidth={STROKE} aria-hidden />
          <span className="grow truncate strong">{lone}</span>
          <RemoveMenu name={lone} placement="below" onRemove={onRemove} />
        </div>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
      {file !== null ? (
        <div className="file-view">
          <div className="row">
            <Button size="sm" variant="ghost" onClick={() => setFile(null)}>
              <ArrowLeft size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Back
            </Button>
            <span className="small muted truncate">{file}</span>
          </div>
          {text ? (
            <>
              <pre className="file-text" tabIndex={0}>{text.text}</pre>
              {text.truncated && <div className="small muted">Showing lines {text.startLine}–{text.endLine} of {text.totalLines}.</div>}
            </>
          ) : !error ? (
            <div className="folder-loading small"><Spinner /> Opening {file.split("/").at(-1)}…</div>
          ) : null}
        </div>
      ) : dir ? (
        <ul className="folder-list">
          {dir.entries.length === 0 && <li className="small muted pad">This folder is empty.</li>}
          {dir.entries.map((e, i) => (
            <li key={e.name} className={path === "" && removable?.has(e.name) ? "has-menu" : undefined}>
              <button type="button" onClick={() => (e.type === "dir" ? setPath(join(e.name)) : setFile(join(e.name)))}>
                {e.type === "dir" ? <FolderOpen size={ICON_SM} strokeWidth={STROKE} aria-hidden /> : <File size={ICON_SM} strokeWidth={STROKE} aria-hidden />}
                <span className="grow truncate">{e.name}</span>
                {e.type === "file" && e.size !== undefined && <span className="small muted">{sizeLabel(e.size)}</span>}
              </button>
              {path === "" && removable?.has(e.name) && (
                <RemoveMenu name={e.name} placement={dir.entries.length > 3 && i === dir.entries.length - 1 ? "above" : "below"} className="folder-row-menu" onRemove={onRemove} />
              )}
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

/** The three-dot menu of a shared item. Remove only stops sharing it. */
function RemoveMenu({ name, placement, className, onRemove }: { name: string; placement: "above" | "below"; className?: string; onRemove: (name: string) => void }) {
  return (
    <Menu
      label={`Options for ${name}`}
      align="end"
      placement={placement}
      className={className}
      items={[{ label: "Remove", title: "Stops sharing it. Nothing is deleted from your computer.", icon: <X size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => onRemove(name) }]}
      trigger={({ toggle, open }) => (
        <button type="button" className={`icon-btn row-more folder-row-more ${open ? "open" : ""}`} aria-label={`Options for ${name}`} title="Options (removing only stops sharing)" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          <MoreHorizontal size={ICON_SM} strokeWidth={STROKE} />
        </button>
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
