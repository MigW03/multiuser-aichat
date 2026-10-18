import { contextBridge } from "electron";
import { folderApi } from "./folder-preload.ts";

// The renderer is the same React app as the web version. Only expose what it needs, as plain data.
// authRedirect / shareBase are the multiuserchat:// links, offered only when the OS sends them back to this app
// (installed builds; the main process passes --mc-deeplinks then).
const deepLinks = process.argv.includes("--mc-deeplinks");
contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  folder: folderApi,
  ...(deepLinks ? { authRedirect: "multiuserchat://auth", shareBase: "multiuserchat://open" } : {}),
});
