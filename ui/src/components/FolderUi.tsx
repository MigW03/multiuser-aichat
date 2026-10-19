import { FOLDER_LIMITS, type FolderListResult, type FolderReadResult, type GitStatusResult, type ProjectFolder, type ProjectSummary } from "@mc/shared";
import { ArrowLeft, ChevronRight, File, FilePlus, Folder, FolderOpen, FolderPlus, GitBranch, PanelRightClose, PanelRightOpen, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, ApiRequestError } from "../api.ts";
import { notifyChanged, useApp } from "../data.tsx";
import { folderBridge, useLocalFolder, useProjectFolder, type FolderBridge } from "../lib/folder.ts";
import { DiffView } from "./Changes.tsx";
import { NoticeBody, shareFolderNotice } from "./Notice.tsx";
import { Button, Dialog, ErrorLine, ICON, ICON_SM, IconButton, InfoTip, Spinner, STROKE, useToast } from "./kit.tsx";

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
    <IconButton label="Show shared folder" onClick={folderPanel.toggle} aria-expanded={folderPanel.open}>
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
    <section className="side-card folder-card" aria-label="Shared folder">
      <header className="side-card-head">
        <Folder size={ICON_SM} strokeWidth={STROKE} aria-hidden />
        <b className="grow truncate" title={folder.data.name}>{folder.data.name}</b>
        <FolderInfo />
        <span className="side-card-status small muted">
          <StatusDot on={folder.data.online} />
          {folder.data.online ? "Online" : "Offline"}
        </span>
        <IconButton label="Hide shared folder" onClick={onClose} className="sm">
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
    <section className="side-card folder-card empty" aria-label="Shared folder">
      <span className="folder-empty-close">
        <IconButton label="Hide shared folder" onClick={onClose} className="sm">
          <PanelRightClose size={ICON_SM} strokeWidth={STROKE} />
        </IconButton>
      </span>
      <Folder size={22} strokeWidth={1.75} aria-hidden />
      <div className="strong">Shared folder</div>
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
  const toast = useToast();
  const local = useLocalFolder(host ? project.id : null);
  const share = useShare(project, bridge, true);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
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

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      await api.unlinkFolder(project.id);
      await bridge?.unlink(project.id);
      notifyChanged();
      toast.push("Stopped sharing");
      setConfirmStop(false);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const manage = host && !!bridge && typeof bridge.remove === "function";
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
      {/* Keyed by when it was last shared: adding or removing an item starts browsing from the top again. */}
      {folder.online ? <FolderBrowser key={folder.linked_at} projectId={project.id} rootName={folder.name} /> : <div className="grow" />}
      {folder.online && <GitChanges key={`git-${folder.linked_at}`} projectId={project.id} />}
      {manage && local?.linked && (
        <div className="shared-items">
          <div className="small muted">Shared from this computer</div>
          <ul>
            {local.items.map((i) => (
              <li key={i.name}>
                {i.kind === "dir" ? <Folder size={ICON_SM} strokeWidth={STROKE} aria-hidden /> : <File size={ICON_SM} strokeWidth={STROKE} aria-hidden />}
                <span className="grow truncate">{i.name}</span>
                <IconButton label={`Stop sharing ${i.name}`} className="sm" onClick={() => void remove(i.name)}>
                  <X size={ICON_SM} strokeWidth={STROKE} />
                </IconButton>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(error || share.error) && <ErrorLine>{error ?? share.error}</ErrorLine>}
      {manage && (
        <div className="side-card-actions">
          <Button size="sm" onClick={() => share.start("folder")} busy={share.busy}>
            <FolderPlus size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Folder
          </Button>
          <Button size="sm" onClick={() => share.start("files")}>
            <FilePlus size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Files
          </Button>
          <div className="grow" />
          <Button size="sm" variant="ghost" onClick={() => setConfirmStop(true)}>
            Stop sharing
          </Button>
        </div>
      )}
      {share.dialog}
      {confirmStop && (
        <Dialog title="Stop sharing these files?" onClose={() => setConfirmStop(false)}>
          <p className="lead">Members and the AI can no longer read anything shared in {project.name}. Nothing on your computer is changed or deleted.</p>
          {error && <ErrorLine>{error}</ErrorLine>}
          <div className="dialog-actions">
            <Button onClick={() => setConfirmStop(false)}>Cancel</Button>
            <Button variant="danger" busy={busy} onClick={() => void stop()}>
              Stop sharing
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** Browse the shared folder, one level at a time, and read a file. All of it goes through the server to the host's app. */
function FolderBrowser({ projectId, rootName }: { projectId: string; rootName: string }) {
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
      <nav className="folder-crumbs" aria-label="Folder path">
        <button type="button" onClick={() => { setPath(""); setFile(null); }} className="truncate">
          {rootName}
        </button>
        {parts.map((p, i) => (
          <span key={`${i}-${p}`} className="row">
            <ChevronRight size={ICON_SM} strokeWidth={STROKE} aria-hidden />
            <button type="button" onClick={() => { setPath(parts.slice(0, i + 1).join("/")); setFile(null); }} className="truncate">
              {p}
            </button>
          </span>
        ))}
      </nav>
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
          {dir.entries.map((e) => (
            <li key={e.name}>
              <button type="button" onClick={() => (e.type === "dir" ? setPath(join(e.name)) : setFile(join(e.name)))}>
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

const GIT_LETTER: Record<string, string> = { M: "M", A: "A", D: "D", R: "R", C: "C", "?": "new", U: "!" };

/** What changed in the shared folder's git repository. Shown only when the host switched git on and the folder is a repository. */
function GitChanges({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);

  const load = useCallback(() => {
    api.gitStatus(projectId).then(
      (r) => {
        setStatus(r);
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

  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    setDiff(null);
    if (open === null) return;
    let live = true;
    api.gitDiff(projectId, open, "head").then(
      (r) => live && setDiff(r.text),
      (e: unknown) => live && setDiff(messageOf(e)),
    );
    return () => {
      live = false;
    };
  }, [projectId, open]);

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
