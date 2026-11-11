import { ipcRenderer, webUtils } from "electron";

// What the page may do with the files this person shares. It can say who is signed in, ask what is shared from this
// computer, open the native "choose" dialog, hear what was dropped on the files panel (names only), remove an item and
// stop sharing. It cannot name a path or read a file.
type Dropped = { ok: true; items: { name: string; kind: "dir" | "file" }[]; skipped: string[] } | { ok: false; error: string };
const dropListeners = new Set<(projectId: string, dropped: Dropped) => void>();

// A drop on an element marked data-files-drop="<project id>" hands the real paths of what was dragged in from the
// person's file system to the app, which checks them and keeps them. webUtils reads a path only from a file that came
// from the file system, so a page that builds its own File objects gets nothing, and a script cannot fake the event.
window.addEventListener(
  "drop",
  (event) => {
    const projectId = (event.target as Element | null)?.closest?.("[data-files-drop]")?.getAttribute("data-files-drop");
    if (!event.isTrusted || !projectId) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    const paths = files.slice(0, 50).map((f) => webUtils.getPathForFile(f)).filter((p) => p.length > 0);
    void ipcRenderer.invoke("folder:drop-stage", projectId, paths).then((dropped: Dropped) => dropListeners.forEach((cb) => cb(projectId, dropped)));
  },
  true,
);

export const folderApi = {
  /** Tells the app who is signed in and which projects they belong to, so it can serve what they share there. null when signed out. */
  setSession: (session: { serverUrl: string; token: string; userId: string; projects: string[] } | null): Promise<void> => ipcRenderer.invoke("folder:set-session", session),
  get: (projectId: string): Promise<unknown> => ipcRenderer.invoke("folder:get", projectId),
  /** Opens the native dialog to add folders or files. */
  pick: (projectId: string, kind: "folder" | "files"): Promise<unknown> => ipcRenderer.invoke("folder:pick", projectId, kind),
  /** Something was dropped on a data-files-drop element: what it is called, nothing more. It waits in the app until dropCommit. */
  onDrop: (callback: (projectId: string, dropped: Dropped) => void): (() => void) => {
    dropListeners.add(callback);
    return () => void dropListeners.delete(callback);
  },
  /** Shares what was dropped (after the page showed the notice, when one is due). */
  dropCommit: (projectId: string): Promise<unknown> => ipcRenderer.invoke("folder:drop-commit", projectId),
  dropCancel: (projectId: string): Promise<void> => ipcRenderer.invoke("folder:drop-cancel", projectId),
  /** The server refused what this app reported (for example too many items in the project). */
  onItemsError: (callback: (projectId: string, code: string) => void): (() => void) => {
    const listener = (_event: unknown, e: unknown) => {
      const v = e as { projectId?: unknown; code?: unknown } | null;
      if (typeof v?.projectId === "string" && typeof v.code === "string") callback(v.projectId, v.code);
    };
    ipcRenderer.on("folder:items-error", listener);
    return () => void ipcRenderer.removeListener("folder:items-error", listener);
  },
  /** Stops sharing one item. Resolves to the new name, or null when nothing is left. */
  remove: (projectId: string, name: string): Promise<{ name: string | null }> => ipcRenderer.invoke("folder:remove", projectId, name),
  /**
   * Runs an HTML file this person shares, with its scripts, in the preview's strict mode (no network). The page names the project
   * and the shared path; the app checks it, asks in a window of its own, and resolves to the address for the preview to open.
   */
  runPage: (projectId: string, path: string): Promise<unknown> => ipcRenderer.invoke("folder:run-page", projectId, path),
  /** Reconnects a project now. */
  connect: (projectId: string): Promise<void> => ipcRenderer.invoke("folder:connect", projectId),
  unlink: (projectId: string): Promise<void> => ipcRenderer.invoke("folder:unlink", projectId),
  /** The host's switches for AI changes to files, git and commands (all off by default; turning on commands asks in a native window). Only the keys given change. */
  setCaps: (projectId: string, caps: { edit?: boolean; git?: boolean; exec?: boolean }): Promise<unknown> => ipcRenderer.invoke("folder:set-caps", projectId, caps),
  setAuto: (projectId: string, auto: { edit?: boolean; exec?: boolean }): Promise<unknown> => ipcRenderer.invoke("folder:set-auto", projectId, auto),
  /** AI changes waiting for this computer's owner to decide. */
  approvals: (): Promise<unknown[]> => ipcRenderer.invoke("folder:approvals"),
  /** The host's click. The file is written only by this call. */
  decide: (projectId: string, id: string, approve: boolean): Promise<boolean> => ipcRenderer.invoke("folder:decide", projectId, id, approve),
  onApproval: (callback: (view: unknown) => void): (() => void) => {
    const listener = (_event: unknown, view: unknown) => callback(view);
    ipcRenderer.on("folder:approval", listener);
    return () => void ipcRenderer.removeListener("folder:approval", listener);
  },
  onApprovalGone: (callback: (gone: { projectId: string; id: string }) => void): (() => void) => {
    const listener = (_event: unknown, gone: unknown) => {
      const g = gone as { projectId?: unknown; id?: unknown } | null;
      if (typeof g?.projectId === "string" && typeof g.id === "string") callback({ projectId: g.projectId, id: g.id });
    };
    ipcRenderer.on("folder:approval-gone", listener);
    return () => void ipcRenderer.removeListener("folder:approval-gone", listener);
  },
  /**
   * Commands this person chose to always allow (ticked in the app's own confirmation window: the page cannot add one). The
   * page can list them and revoke them, and hears when one ran without asking.
   */
  allow: {
    list: (projectId: string): Promise<unknown[]> => ipcRenderer.invoke("folder:allow-list", projectId),
    revoke: (projectId: string, ruleId: string): Promise<boolean> => ipcRenderer.invoke("folder:allow-revoke", projectId, ruleId),
    revokeAll: (projectId: string): Promise<void> => ipcRenderer.invoke("folder:allow-revoke-all", projectId),
    onChange: (callback: (projectId: string) => void): (() => void) => {
      const listener = (_event: unknown, projectId: unknown) => typeof projectId === "string" && callback(projectId);
      ipcRenderer.on("folder:allow-changed", listener);
      return () => void ipcRenderer.removeListener("folder:allow-changed", listener);
    },
    onRan: (callback: (ran: unknown) => void): (() => void) => {
      const listener = (_event: unknown, ran: unknown) => callback(ran);
      ipcRenderer.on("folder:auto-ran", listener);
      return () => void ipcRenderer.removeListener("folder:auto-ran", listener);
    },
  },
  onChange: (callback: (projectId: string) => void): (() => void) => {
    const listener = (_event: unknown, projectId: unknown) => typeof projectId === "string" && callback(projectId);
    ipcRenderer.on("folder:changed", listener);
    return () => void ipcRenderer.removeListener("folder:changed", listener);
  },
  /**
   * The package.json scripts of the folders this person shares from this computer. The page names a folder and a script
   * and never sends command text: the app reads package.json itself. Run only asks; the owner approves in the approval
   * dock and confirms in a window of the app's own.
   */
  scripts: {
    get: (projectId: string, list = true): Promise<unknown> => ipcRenderer.invoke("folder:scripts-get", projectId, list),
    run: (projectId: string, key: string, name: string): Promise<unknown> => ipcRenderer.invoke("folder:script-run", projectId, key, name),
    cancel: (projectId: string, key: string, name: string): Promise<void> => ipcRenderer.invoke("folder:script-cancel", projectId, key, name),
    stop: (projectId: string, key: string, name: string): Promise<boolean> => ipcRenderer.invoke("folder:script-stop", projectId, key, name),
    log: (projectId: string, key: string, name: string): Promise<string | null> => ipcRenderer.invoke("folder:script-log", projectId, key, name),
    clear: (projectId: string, key: string, name: string): Promise<void> => ipcRenderer.invoke("folder:script-clear", projectId, key, name),
    /** The Scripts tab was looked at: a crash is not news any more. */
    seen: (projectId: string): Promise<void> => ipcRenderer.invoke("folder:scripts-seen", projectId),
    onChange: (callback: (projectId: string) => void): (() => void) => {
      const listener = (_event: unknown, projectId: unknown) => typeof projectId === "string" && callback(projectId);
      ipcRenderer.on("folder:scripts-changed", listener);
      return () => void ipcRenderer.removeListener("folder:scripts-changed", listener);
    },
  },
};

// Connected tools (MCP). They belong to the signed-in person, not a project. The page tells the app who is signed in and can
// read the setup and change switches. Adding a server shows its command in a window the app opens itself; the page cannot
// click it and never receives environment values.
export const mcpApi = {
  /** Who is signed in and a token for the chat server; null when signed out. */
  setSession: (session: { serverUrl: string; token: string; userId: string } | null): Promise<void> => ipcRenderer.invoke("mcp:set-session", session),
  get: (): Promise<unknown> => ipcRenderer.invoke("mcp:get"),
  /** `command` is the command line as typed; `env` is KEY=value lines. The app splits them and shows the result for confirmation. */
  add: (server: { name: string; command: string; env: string }): Promise<unknown> => ipcRenderer.invoke("mcp:add", server),
  remove: (name: string): Promise<unknown> => ipcRenderer.invoke("mcp:remove", name),
  setServer: (name: string, enabled: boolean): Promise<unknown> => ipcRenderer.invoke("mcp:set-server", name, enabled),
  setTool: (name: string, tool: string, enabled: boolean): Promise<unknown> => ipcRenderer.invoke("mcp:set-tool", name, tool, enabled),
  retry: (name: string): Promise<unknown> => ipcRenderer.invoke("mcp:retry", name),
  onChange: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("mcp:changed", listener);
    return () => void ipcRenderer.removeListener("mcp:changed", listener);
  },
};

// "Use my Claude Code login": the page can read the status, ask to switch it on or off (the app asks in a window of its own),
// and ask to pick the `claude` program in the system's dialog. It names no path and reads no sign-in.
export const claudeCodeApi = {
  get: (): Promise<unknown> => ipcRenderer.invoke("claudecode:get"),
  /** Looks for `claude` again and asks it whether it is signed in. */
  refresh: (): Promise<unknown> => ipcRenderer.invoke("claudecode:refresh"),
  setEnabled: (enabled: boolean): Promise<unknown> => ipcRenderer.invoke("claudecode:set-enabled", enabled),
  /** The plan limits `claude` reported (null: none known). `refresh` asks `claude` directly first. */
  usage: (refresh: boolean): Promise<unknown> => ipcRenderer.invoke("claudecode:usage", refresh),
  chooseBinary: (): Promise<unknown> => ipcRenderer.invoke("claudecode:choose-binary"),
  resetBinary: (): Promise<unknown> => ipcRenderer.invoke("claudecode:reset-binary"),
  onChange: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("claudecode:changed", listener);
    return () => void ipcRenderer.removeListener("claudecode:changed", listener);
  },
};

// The preview of a web page from this computer (localhost), shown by the app in a browser view of its own over the space the
// page reserves for it. The page sends addresses and rectangles; the app checks the address again and is the only one that
// ever loads the previewed page, which has no connection back to the app.
export const previewApi = {
  /** Opens (or moves to) a localhost address in the preview, within the rectangle the page reserves. Resolves to the address opened, or null when it is not allowed. */
  open: (url: string, bounds: unknown): Promise<{ ok: boolean; url?: string }> => ipcRenderer.invoke("preview:open", url, bounds),
  setBounds: (bounds: unknown): void => ipcRenderer.send("preview:bounds", bounds),
  /** Hides or shows the preview (it floats above the page, so a dialog needs the space). Hiding resolves to a picture of it to leave in its place. */
  setVisible: (visible: boolean): Promise<string | null> => ipcRenderer.invoke("preview:visible", visible),
  /** `quiet`: a retry in the background, the error stays shown until the address answers. */
  reload: (quiet = false): void => ipcRenderer.send("preview:reload", quiet),
  back: (): void => ipcRenderer.send("preview:back"),
  forward: (): void => ipcRenderer.send("preview:forward"),
  close: (): void => ipcRenderer.send("preview:close"),
  /** Opens the current address in the person's own browser. */
  openExternal: (): void => ipcRenderer.send("preview:external"),
  get: (): Promise<unknown> => ipcRenderer.invoke("preview:get"),
  /** Which common dev-server ports on this computer accept connections now. */
  scan: (): Promise<number[]> => ipcRenderer.invoke("preview:scan"),
  /** Forgets the previewed site's cookies and stored data. */
  clearData: (): Promise<boolean> => ipcRenderer.invoke("preview:clear"),
  onState: (callback: (state: unknown) => void): (() => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on("preview:state", listener);
    return () => void ipcRenderer.removeListener("preview:state", listener);
  },
};

// Custom panels: the AI's tabs for this person, kept in this app's folder on this computer. The page can list, read, rename,
// reorder and save a panel's own data. Deleting a panel or clearing its data asks in a window of the app's own. Making or
// changing a panel is not here: that comes only from a draft the person approves.
export const panelsApi = {
  list: (projectId: string): Promise<unknown> => ipcRenderer.invoke("panels:list", projectId),
  get: (projectId: string, panelId: string): Promise<unknown> => ipcRenderer.invoke("panels:get", projectId, panelId),
  saveState: (projectId: string, panelId: string, state: unknown): Promise<unknown> => ipcRenderer.invoke("panels:save-state", projectId, panelId, state),
  rename: (projectId: string, panelId: string, name: string): Promise<unknown> => ipcRenderer.invoke("panels:rename", projectId, panelId, name),
  setIcon: (projectId: string, panelId: string, icon: string): Promise<unknown> => ipcRenderer.invoke("panels:set-icon", projectId, panelId, icon),
  move: (projectId: string, panelId: string, delta: -1 | 1): Promise<unknown> => ipcRenderer.invoke("panels:move", projectId, panelId, delta),
  undo: (projectId: string, panelId: string): Promise<unknown> => ipcRenderer.invoke("panels:undo", projectId, panelId),
  clearState: (projectId: string, panelId: string): Promise<unknown> => ipcRenderer.invoke("panels:clear-state", projectId, panelId),
  delete: (projectId: string, panelId: string): Promise<unknown> => ipcRenderer.invoke("panels:delete", projectId, panelId),
  /** What the AI proposed and the person has not decided: new panels, new versions, delete requests. */
  drafts: (projectId: string): Promise<unknown> => ipcRenderer.invoke("panels:drafts", projectId),
  /** The person's click on Add / Update: the app saves the proposal it kept (the page sends only its id). */
  commitDraft: (projectId: string, id: string): Promise<unknown> => ipcRenderer.invoke("panels:draft-commit", projectId, id),
  discardDraft: (projectId: string, id: string): Promise<unknown> => ipcRenderer.invoke("panels:draft-discard", projectId, id),
  onDraftsChange: (callback: (projectId: string) => void): (() => void) => {
    const listener = (_event: unknown, projectId: unknown) => typeof projectId === "string" && callback(projectId);
    ipcRenderer.on("panels:drafts-changed", listener);
    return () => void ipcRenderer.removeListener("panels:drafts-changed", listener);
  },
  /** One read of a panel's source on this computer's tool servers. Resolves to null when the source isn't a server on this computer. */
  readSource: (projectId: string, panelId: string, sourceId: string): Promise<unknown> => ipcRenderer.invoke("panels:read-source", projectId, panelId, sourceId),
  onChange: (callback: (projectId: string) => void): (() => void) => {
    const listener = (_event: unknown, projectId: unknown) => typeof projectId === "string" && callback(projectId);
    ipcRenderer.on("panels:changed", listener);
    return () => void ipcRenderer.removeListener("panels:changed", listener);
  },
};

// "Erase Nido data on this computer". confirm asks in a window of the app's own; run only works right after a yes, and quits the app.
export const eraseApi = {
  confirm: (): Promise<boolean> => ipcRenderer.invoke("erase:confirm"),
  run: (): Promise<boolean> => ipcRenderer.invoke("erase:run"),
};
