import { ipcRenderer } from "electron";

// What the page may do about updates of the app itself: read the state, ask for a check, start a download, restart into a
// downloaded version, and choose whether new versions download without asking. The page never names a file or an address.
export const updateApi = {
  get: (): Promise<unknown> => ipcRenderer.invoke("update:get"),
  check: (): Promise<unknown> => ipcRenderer.invoke("update:check"),
  download: (): Promise<unknown> => ipcRenderer.invoke("update:download"),
  install: (): Promise<boolean> => ipcRenderer.invoke("update:install"),
  setAuto: (on: boolean): Promise<unknown> => ipcRenderer.invoke("update:set-auto", on),
  onState: (callback: (state: unknown) => void): (() => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on("update:state", listener);
    return () => void ipcRenderer.removeListener("update:state", listener);
  },
};
