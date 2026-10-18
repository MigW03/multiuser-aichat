import { app, BrowserWindow, net, protocol, session, shell } from "electron";
import { join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDeepLink, SCHEME } from "./deeplink.ts";
import { setupFolderHost } from "./folder-ipc.ts";

// Production loads the web build from a private app:// origin (not file://, which would give the page
// access to the whole disk). Development loads the Vite dev server.
const DEV_URL = process.env.DESKTOP_DEV_URL;
const APP_ORIGIN = "app://desktop";
// Packaged: electron-builder copies the web build to <Resources>/web-dist. Unpackaged: the web workspace's own build.
const WEB_DIST = app.isPackaged ? join(process.resourcesPath, "web-dist") : resolve(__dirname, "../../web/dist");

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  // Supabase (REST + realtime) and the chat server. The local server is for development builds only.
  `connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.fly.dev${app.isPackaged ? "" : " http://localhost:8787"}`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
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

// --- deep links ---------------------------------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let pendingLink: string | null = null;
const deepLinksRegistered = app.isPackaged && app.setAsDefaultProtocolClient(SCHEME);

function openLink(raw: string) {
  const link = parseDeepLink(raw);
  const win = mainWindow;
  if (!link) return;
  if (!win || win.isDestroyed()) {
    pendingLink = raw;
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const base = DEV_URL ? `${new URL(DEV_URL).origin}/` : `${APP_ORIGIN}/index.html`;
  void win.loadURL(`${base}${link.hash}`).then(() => {
    // Supabase reads the session from the address only when the page starts, so a link that only changed the
    // hash has to restart it.
    if (link.reload) win.webContents.reload();
  }, () => undefined);
}

const linkFrom = (argv: string[]) => argv.find((a) => a.startsWith(`${SCHEME}://`));

// One window only: a second launch (Windows and Linux deliver deep links this way) hands its link to the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const link = linkFrom(argv);
    if (link) openLink(link);
    else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    openLink(url);
  });
  pendingLink = linkFrom(process.argv) ?? null;

  app.whenReady().then(() => {
    // The app asks for no camera, microphone, location and so on; say no to all of it.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    if (!DEV_URL) serveWebBuild();
    setupFolderHost({ allowedOrigin: DEV_URL ? new URL(DEV_URL).origin : APP_ORIGIN, getWindow: () => mainWindow });
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (e) => e.preventDefault());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
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
      // Tells the preload script whether multiuserchat:// links come back to this app.
      additionalArguments: deepLinksRegistered ? ["--mc-deeplinks"] : [],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  const allowedOrigin = DEV_URL ? new URL(DEV_URL).origin : APP_ORIGIN;
  // Links open in the user's browser, and only https ones. The app window never leaves its own origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    let origin: string | null = null;
    try {
      origin = new URL(url).origin;
    } catch {
      /* not a URL: block */
    }
    if (origin !== allowedOrigin) event.preventDefault();
  });

  const initial = pendingLink ? parseDeepLink(pendingLink) : null;
  pendingLink = null;
  const start = DEV_URL ?? `${APP_ORIGIN}/index.html`;
  const load = () => win.loadURL(`${start}${initial?.hash ?? ""}`).catch(() => setTimeout(load, 500)); // dev: wait for Vite to start
  if (DEV_URL) void load();
  else void win.loadURL(`${start}${initial?.hash ?? ""}`);
}
