import { contextBridge, ipcRenderer } from "electron";
import { folderApi, mcpApi, previewApi } from "./folder-preload.ts";

// The renderer is the same React app as the web version. Only expose what it needs, as plain data.
// authRedirect / shareBase are the multiuserchat:// links, offered only when the OS sends them back to this app
// (installed builds; the main process passes --mc-deeplinks then).
const deepLinks = process.argv.includes("--mc-deeplinks");
contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  // Tells the window frame to match the app theme ("system" | "light" | "dark").
  setTheme: (pref: "system" | "light" | "dark") => ipcRenderer.send("theme:set", pref),
  folder: folderApi,
  mcp: mcpApi,
  preview: previewApi,
  ...(deepLinks ? { authRedirect: "multiuserchat://auth", shareBase: "multiuserchat://open" } : {}),
});
