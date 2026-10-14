import { contextBridge } from "electron";

// The renderer is the same React app as the web version. Only expose what it needs, as plain data.
contextBridge.exposeInMainWorld("desktop", { platform: process.platform });
