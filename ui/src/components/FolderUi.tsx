import { FOLDER_LIMITS, type FolderListResult, type FolderReadResult, type ProjectFolder, type ProjectSummary } from "@mc/shared";
import { ArrowLeft, ChevronRight, File, Folder, FolderOpen, FolderPlus, FolderX, PanelRightClose, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { notifyChanged, useApp } from "../data.tsx";
import { folderBridge, useLocalFolder, useProjectFolder } from "../lib/folder.ts";
import { NoticeBody, shareFolderNotice } from "./Notice.tsx";
import { Button, Dialog, ErrorLine, ICON, ICON_SM, IconButton, Spinner, STROKE, useToast } from "./kit.tsx";

// The project's shared folder: a panel on the right of the chat, opened from a row in the left panel or a chip in the
// chat header. It shows whether the host's app is serving the folder, lets any member browse it (read only), and lets
// the host share, change or stop sharing it from the desktop app.

const messageOf = (e: unknown, fallback = "Something went wrong.") => (e instanceof Error ? e.message : fallback);

const sizeLabel = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function StatusDot({ on }: { on: boolean }) {
  return <span className={`status-dot ${on ? "on" : ""}`} aria-hidden />;
}

/** The row under the project name in the left panel. Hosts without a folder see an invitation to share one; others see nothing. */
export function FolderRow({ project }: { project: ProjectSummary }) {
  const { folderPanel } = useApp();
  const folder = useProjectFolder(project.id);
  const host = project.my_role === "host";
  if (folder.data === undefined) return null;
  if (folder.data === null && !host) return null;
  return (
    <div className="panel-folder">
      {folder.data ? (
        <button
          type="button"
          className={`folder-row ${folderPanel.open ? "active" : ""}`}
          onClick={folderPanel.toggle}
          aria-pressed={folderPanel.open}
          aria-label={`Shared folder ${folder.data.name}, ${folder.data.online ? "online" : "offline"}`}
        >
          <Folder size={ICON} strokeWidth={STROKE} aria-hidden />
          <span className="grow truncate">{folder.data.name}</span>
          <StatusDot on={folder.data.online} />
          <span className="small muted">{folder.data.online ? "Online" : "Offline"}</span>
        </button>
      ) : (
        <button type="button" className={`folder-row empty ${folderPanel.open ? "active" : ""}`} onClick={folderPanel.toggle} aria-pressed={folderPanel.open}>
          <FolderPlus size={ICON} strokeWidth={STROKE} aria-hidden />
          <span className="grow">Share a folder</span>
        </button>
      )}
    </div>
  );
}

/** A small chip in the chat header of a project chat that has a shared folder. Shows and hides the folder panel. */
export function FolderChip({ project }: { project: ProjectSummary }) {
  const { folderPanel } = useApp();
  const folder = useProjectFolder(project.id);
  if (!folder.data) return null;
  return (
    <button
      type="button"
      className={`folder-chip ${folderPanel.open ? "active" : ""}`}
      onClick={folderPanel.toggle}
      aria-pressed={folderPanel.open}
      title={`${folderPanel.open ? "Hide" : "Show"} the shared folder: ${folder.data.name} (${folder.data.online ? "online" : "offline"})`}
    >
      <Folder size={ICON_SM} strokeWidth={STROKE} aria-hidden />
      <span className="folder-chip-name truncate">{folder.data.name}</span>
      <StatusDot on={folder.data.online} />
    </button>
  );
}

/** The panel on the right of a project's chats. */
export function FolderPanel({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const folder = useProjectFolder(project.id);
  return (
    <aside className="right-panel" aria-label="Shared folder">
      <header className="right-panel-head">
        <Folder size={ICON} strokeWidth={STROKE} aria-hidden />
        <h2 className="grow truncate">{folder.data ? folder.data.name : "Shared folder"}</h2>
        <IconButton label="Hide shared folder" onClick={onClose}>
          <PanelRightClose size={ICON} strokeWidth={STROKE} />
        </IconButton>
      </header>
      <div className="right-panel-body">{folder.data === undefined ? <div className="center-text"><Spinner /></div> : <FolderBody project={project} folder={folder.data} />}</div>
    </aside>
  );
}

function FolderBody({ project, folder }: { project: ProjectSummary; folder: ProjectFolder | null }) {
  const toast = useToast();
  const host = project.my_role === "host";
  const bridge = folderBridge();
  const local = useLocalFolder(host ? project.id : null);
  const [view, setView] = useState<"main" | "notice" | "stop">("main");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function share() {
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      const picked = await bridge.pick(project.id); // a native dialog: the page never sees the path
      if (!picked.ok) {
        if (picked.error) setError(picked.error);
        return;
      }
      try {
        await api.linkFolder(project.id, picked.name);
      } catch (e) {
        await bridge.unlink(project.id);
        setError(messageOf(e));
        return;
      }
      // Starts serving now. An app opened before this version has no connect: restarting it does the same.
      if (typeof bridge.connect === "function") await bridge.connect(project.id);
      else toast.push("Restart the desktop app to bring the folder online.", "info");
      notifyChanged();
      setView("main");
      toast.push("Folder shared");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      await api.unlinkFolder(project.id);
      await bridge?.unlink(project.id);
      notifyChanged();
      toast.push("Stopped sharing the folder");
      setView("main");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const notHere = host && !!bridge && !!folder && !!local && !local.linked;
  const refused = host && !!bridge && !!folder && local?.linked && local.state === "rejected";

  const dialog =
    view === "notice" ? (
      <Dialog onClose={() => setView("main")} width={480} label={shareFolderNotice(project.name).title}>
        <NoticeBody {...shareFolderNotice(project.name)} confirmLabel="Choose a folder" cancelLabel="Cancel" busy={busy} error={error} onConfirm={() => void share()} onCancel={() => setView("main")} />
      </Dialog>
    ) : view === "stop" ? (
      <Dialog title="Stop sharing this folder?" onClose={() => setView("main")}>
        <p className="lead">Members and the AI can no longer read the files in {project.name}. Nothing on your computer is changed or deleted.</p>
        {error && <ErrorLine>{error}</ErrorLine>}
        <div className="dialog-actions">
          <Button onClick={() => setView("main")}>Cancel</Button>
          <Button variant="danger" busy={busy} onClick={() => void stop()}>
            Stop sharing
          </Button>
        </div>
      </Dialog>
    ) : null;

  if (!folder) {
    return (
      <>
        <div className="folder-empty">
          <span className="empty-icon" aria-hidden>
            <FolderPlus size={22} strokeWidth={1.75} />
          </span>
          {host ? (
            bridge ? (
              <p className="small muted">Share one folder from your computer. Everyone in {project.name} can read its files, and the AI can use them when answering in project chats. It is read only, and nothing is uploaded.</p>
            ) : (
              <p className="small muted">Folders are shared from your computer, so this takes the desktop app. Open {project.name} there and choose a folder. This panel then shows whether it is online.</p>
            )
          ) : (
            <p className="small muted">Nobody has shared a folder in {project.name} yet. The project host can share one from the desktop app.</p>
          )}
          {host && bridge && (
            <Button variant="primary" onClick={() => setView("notice")}>
              <FolderPlus size={ICON} strokeWidth={STROKE} aria-hidden /> Choose a folder
            </Button>
          )}
          {view === "main" && error && <ErrorLine>{error}</ErrorLine>}
        </div>
        {dialog}
      </>
    );
  }

  return (
    <>
      <div className="folder-status">
        <StatusDot on={folder.online} />
        <div className="grow">
          <div className="strong">{folder.online ? "Online" : "Offline"}</div>
          <div className="small muted">
            {folder.online
              ? "Members and the AI can read these files. Read only: nobody can change them."
              : "The host's desktop app isn't connected, so the files can't be read right now. The AI will say the folder is unavailable."}
          </div>
        </div>
      </div>
      {notHere && (
        <div className="plan-warn" role="status">
          <TriangleAlert size={ICON} strokeWidth={STROKE} aria-hidden />
          <div className="small">This computer isn't serving the folder. It was shared from another computer, or the link was lost. Choose the folder again here to bring it online.</div>
        </div>
      )}
      {refused && (
        <div className="plan-warn" role="status">
          <TriangleAlert size={ICON} strokeWidth={STROKE} aria-hidden />
          <div className="small">The server doesn't accept this computer as the host of the folder. Choose the folder again to share it.</div>
        </div>
      )}
      {folder.online ? <FolderBrowser projectId={project.id} rootName={folder.name} /> : <div className="grow" />}
      <p className="small muted">
        Never shared: .env files, keys, .git, node_modules, build folders and links. Binary files and files over {FOLDER_LIMITS.fileBytes / 1024 / 1024} MB are listed but can't be opened. Text the AI reads is sent to the AI provider of the person who asked.
      </p>
      {view === "main" && error && <ErrorLine>{error}</ErrorLine>}
      {host && bridge && (
        <div className="right-panel-actions">
          <Button size="sm" variant="ghost" onClick={() => setView("stop")}>
            <FolderX size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Stop sharing
          </Button>
          <Button size="sm" onClick={() => setView("notice")}>
            Change folder
          </Button>
        </div>
      )}
      {dialog}
    </>
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
            <div className="center-text"><Spinner /></div>
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
        <div className="center-text"><Spinner /></div>
      ) : null}
    </div>
  );
}
