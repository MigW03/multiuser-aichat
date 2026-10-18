import { ipcRenderer } from "electron";

// What the page may do with the shared folder. It can say who is signed in, ask what is linked on this computer,
// open the native "choose folder" dialog and unlink. It cannot name a path or read a file.
export const folderApi = {
  /** Tells the app who is signed in and which projects they host, so it can serve their linked folders. null when signed out. */
  setSession: (session: { serverUrl: string; token: string; userId: string; hostProjects: string[] } | null): Promise<void> => ipcRenderer.invoke("folder:set-session", session),
  get: (projectId: string): Promise<{ linked: boolean; name: string | null; state: string }> => ipcRenderer.invoke("folder:get", projectId),
  pick: (projectId: string): Promise<{ ok: true; name: string } | { ok: false; error: string | null }> => ipcRenderer.invoke("folder:pick", projectId),
  /** Starts serving a linked folder now (after the page registered it with the server). */
  connect: (projectId: string): Promise<void> => ipcRenderer.invoke("folder:connect", projectId),
  unlink: (projectId: string): Promise<void> => ipcRenderer.invoke("folder:unlink", projectId),
  onChange: (callback: (projectId: string) => void): (() => void) => {
    const listener = (_event: unknown, projectId: unknown) => typeof projectId === "string" && callback(projectId);
    ipcRenderer.on("folder:changed", listener);
    return () => void ipcRenderer.removeListener("folder:changed", listener);
  },
};
