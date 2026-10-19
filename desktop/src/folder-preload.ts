import { ipcRenderer } from "electron";

// What the page may do with the shared folder. It can say who is signed in, ask what is shared from this computer,
// open the native "choose" dialog, remove an item and stop sharing. It cannot name a path or read a file.
export const folderApi = {
  /** Tells the app who is signed in and which projects they host, so it can serve their linked folders. null when signed out. */
  setSession: (session: { serverUrl: string; token: string; userId: string; hostProjects: string[] } | null): Promise<void> => ipcRenderer.invoke("folder:set-session", session),
  get: (projectId: string): Promise<{ linked: boolean; name: string | null; items: { name: string; kind: "dir" | "file" }[]; state: string }> =>
    ipcRenderer.invoke("folder:get", projectId),
  /** Opens the native dialog to add folders or files. */
  pick: (projectId: string, kind: "folder" | "files"): Promise<{ ok: true; name: string; items: { name: string; kind: "dir" | "file" }[]; skipped: string[] } | { ok: false; error: string | null }> =>
    ipcRenderer.invoke("folder:pick", projectId, kind),
  /** Stops sharing one item. Resolves to the new name, or null when nothing is left. */
  remove: (projectId: string, name: string): Promise<{ name: string | null }> => ipcRenderer.invoke("folder:remove", projectId, name),
  /** Starts serving a linked folder now (after the page registered it with the server). */
  connect: (projectId: string): Promise<void> => ipcRenderer.invoke("folder:connect", projectId),
  unlink: (projectId: string): Promise<void> => ipcRenderer.invoke("folder:unlink", projectId),
  /** The host's switches for AI changes to files, git and commands (all off by default; turning on commands asks in a native window). Only the keys given change. */
  setCaps: (projectId: string, caps: { edit?: boolean; git?: boolean; exec?: boolean }): Promise<unknown> => ipcRenderer.invoke("folder:set-caps", projectId, caps),
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
  onChange: (callback: (projectId: string) => void): (() => void) => {
    const listener = (_event: unknown, projectId: unknown) => typeof projectId === "string" && callback(projectId);
    ipcRenderer.on("folder:changed", listener);
    return () => void ipcRenderer.removeListener("folder:changed", listener);
  },
};
