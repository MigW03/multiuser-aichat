import { app, BrowserWindow, net, protocol, shell } from "electron";
import { join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { setupFolderHost } from "./folder-ipc.ts";

// Production loads the web build from a private app:// origin (not file://, which would give the page
// access to the whole disk). Development loads the Vite dev server.
const DEV_URL = process.env.DESKTOP_DEV_URL;
const APP_ORIGIN = "app://desktop";
const WEB_DIST = resolve(__dirname, "../../web/dist");

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  // Supabase (REST + realtime) and the chat server.
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co http://localhost:8787 https://*.fly.dev",
].join("; ");

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function serveWebBuild() {
  protocol.handle("app", async (request) => {
    const { pathname } = new URL(request.url);
    const file = normalize(join(WEB_DIST, decodeURIComponent(pathname === "/" ? "/index.html" : pathname)));
    if (!file.startsWith(WEB_DIST + sep)) return new Response("Not found", { status: 404 }); // no path traversal
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set("Content-Security-Policy", CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    title: "Multiuser Chat",
    backgroundColor: "#16171b",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  const allowedOrigin = DEV_URL ? new URL(DEV_URL).origin : APP_ORIGIN;
  // Links open in the user's browser, and only https ones. The app window never leaves its own origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== allowedOrigin) event.preventDefault();
  });

  if (DEV_URL) {
    const load = () => win.loadURL(DEV_URL).catch(() => setTimeout(load, 500)); // wait for Vite to start
    void load();
  } else {
    void win.loadURL(`${APP_ORIGIN}/index.html`);
  }
}

app.whenReady().then(() => {
  if (!DEV_URL) serveWebBuild();
  setupFolderHost({ allowedOrigin: DEV_URL ? new URL(DEV_URL).origin : APP_ORIGIN, getWindow: () => BrowserWindow.getAllWindows()[0] ?? null });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
