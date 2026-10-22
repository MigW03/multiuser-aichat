import { app, BrowserWindow, ipcMain, session, shell, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent, type Session } from "electron";
import { parsePreviewUrl, PREVIEW_PORTS } from "@mc/shared";
import { originOf } from "./folder-host.ts";
import { cleanBounds, portOpen, type Bounds } from "./preview-util.ts";
import type { RunServer } from "./run-server.ts";

// The preview: a web page from this computer (a project being developed on localhost) shown inside the app's window. It is
// a browser view of its own, laid over the space the page reserves for it, and is walled off from the app:
//  - its own process, with no preload script: it has no bridge to the app and cannot see the app's login or storage;
//  - its own cookie jar (a separate session), so a previewed site can sign in like it would in a browser, and none of it
//    touches the app's session;
//  - only localhost addresses, checked here again (the page checks first), also when the previewed page redirects or
//    follows a link; anything else is refused or sent to the person's browser;
//  - no popups, downloads or device permissions (camera, microphone, location, and so on).
// A second kind of page runs here too: an HTML file someone shares, served from this computer's disk by the run server
// (run-server.ts, "Run page"). That page is not something the person wrote or started: it may come from a teammate or the
// AI. It gets a stricter view ("run" mode): a session of its own that keeps nothing, cannot reach the network at all (a
// request to anywhere but the run server is cancelled in the app, a dead proxy catches the rest, WebRTC cannot send UDP),
// and a page that tries to navigate away goes nowhere (no hand-off to the person's browser). See docs/security-notes.md.

/** `run`: a shared HTML file served by this app, with scripts but no network. `localhost`: the person's own dev server. */
export type PreviewMode = "localhost" | "run";

export type PreviewState = {
  mode: PreviewMode;
  url: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  /** `refused`: nothing is listening at the address (the dev server is not running). */
  error: { kind: "refused" | "failed"; text: string } | null;
};

const PARTITION = "persist:preview";
const ERR_ABORTED = -3;
const ERR_CONNECTION_REFUSED = -102;

export function setupPreview(opts: { allowedOrigin: string; getWindow: () => BrowserWindow | null; run: RunServer }) {
  let view: WebContentsView | null = null;
  let host: BrowserWindow | null = null;
  let bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  let visible = true;
  let jar: Session | null = null;
  let mode: PreviewMode = "localhost";
  let runJar: Promise<Session> | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  // Counts every close: a view that is still being made (the run session is built first) when the panel closes, or when another
  // open replaces it, must not be added afterwards, or it stays on screen with nothing left that can close it.
  let epoch = 0;
  // Every view this module has put in a window and not yet taken out: a close removes all of them, so none can be left behind.
  const made = new Set<{ view: WebContentsView; win: BrowserWindow }>();

  const trusted = (e: IpcMainEvent | IpcMainInvokeEvent) => {
    const win = opts.getWindow();
    return !!win && e.sender === win.webContents && originOf(e.senderFrame?.url) === opts.allowedOrigin;
  };

  const preview = () => {
    if (jar) return jar;
    const s = session.fromPartition(PARTITION);
    s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    s.setPermissionCheckHandler(() => false);
    s.setDevicePermissionHandler(() => false);
    s.on("will-download", (event) => event.preventDefault());
    jar = s;
    return s;
  };

  /** Whether an address is on the run server (any path: the server itself checks the token). */
  const onRunServer = (url: string) => {
    const origin = opts.run.origin();
    try {
      return !!origin && new URL(url).origin === origin;
    } catch {
      return false;
    }
  };

  // The session of a running shared page: in memory (nothing kept), no permissions, and no network except the run server.
  const runSession = () =>
    (runJar ??= (async () => {
      const s = session.fromPartition("runpage");
      s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      s.setPermissionCheckHandler(() => false);
      s.setDevicePermissionHandler(() => false);
      s.on("will-download", (event) => event.preventDefault());
      // Everything that is not the run server (or made by the page itself: data and blob addresses) is cancelled here.
      s.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(onRunServer(details.url) || /^(data|blob):/i.test(details.url)) }));
      // A dead proxy for everything but 127.0.0.1: what the request filter does not see (for example WebSocket upgrades of other kinds) has nowhere to go.
      await s.setProxy({ mode: "fixed_servers", proxyRules: "127.0.0.1:9", proxyBypassRules: "127.0.0.1" });
      return s;
    })());

  /** The page works in CSS pixels; the window may be zoomed. */
  const place = () => {
    if (!view || !host || host.isDestroyed()) return;
    const zoom = host.webContents.getZoomFactor();
    view.setBounds({ x: Math.round(bounds.x * zoom), y: Math.round(bounds.y * zoom), width: Math.round(bounds.width * zoom), height: Math.round(bounds.height * zoom) });
    view.setVisible(visible && bounds.width > 0 && bounds.height > 0);
  };

  let lastError: PreviewState["error"] = null;
  /** The last good address asked for or reached: a failed load leaves the view on an error page, so its own address is not the one to show. */
  let lastUrl = "";
  const stateOf = (): PreviewState | null => {
    if (!view || view.webContents.isDestroyed()) return null;
    const wc = view.webContents;
    return {
      mode,
      url: lastUrl,
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canBack: wc.navigationHistory.canGoBack(),
      canForward: wc.navigationHistory.canGoForward(),
      error: lastError,
    };
  };
  const push = () => {
    const win = opts.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send("preview:state", stateOf());
  };

  // The run server stops a little after the last running page closes (not at once: the page's own panel closes and opens
  // again when the app redraws it, and the address it is about to reopen must still work).
  const stopRunLater = () => {
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      if (!(view && mode === "run")) opts.run.stop();
    }, 10_000);
  };

  function close() {
    epoch++;
    if (view && mode === "run") stopRunLater();
    view = null;
    host = null;
    lastError = null;
    lastUrl = "";
    for (const m of made) {
      try {
        if (!m.win.isDestroyed()) m.win.contentView.removeChildView(m.view);
        if (!m.view.webContents.isDestroyed()) m.view.webContents.close();
      } catch {
        /* the window is already gone */
      }
    }
    const any = made.size > 0;
    made.clear();
    if (any) push();
  }

  async function create(win: BrowserWindow, want: PreviewMode) {
    const born = epoch;
    const sess = want === "run" ? await runSession() : preview();
    if (born !== epoch || win.isDestroyed()) return null;
    const v = new WebContentsView({
      webPreferences: {
        session: sess,
        // No preload: nothing of the app is reachable from the previewed page.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    const wc = v.webContents;
    if (want === "run") {
      // The request filter does not see WebRTC: without this a page could still send UDP packets to the internet.
      wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      clearTimeout(stopTimer);
    }
    v.setBackgroundColor("#ffffff");
    v.setBorderRadius(8);

    // The previewed page stays on localhost. Everything else is refused; an https address goes to the person's browser.
    const guard = (event: { preventDefault: () => void }, url: string) => {
      if (want === "run") {
        // A shared page stays on the run server. Anything else goes nowhere: not even the person's browser (an address a script
        // built could carry what it read).
        if (!onRunServer(url)) event.preventDefault();
        return;
      }
      if (parsePreviewUrl(url)) return;
      event.preventDefault();
      if (url.startsWith("https://")) void shell.openExternal(url);
    };
    wc.on("will-navigate", (event, url) => guard(event, url));
    wc.on("will-redirect", (event, url) => guard(event, url));
    wc.setWindowOpenHandler(({ url }) => {
      if (want === "run") return { action: "deny" };
      if (url.startsWith("https://") && !parsePreviewUrl(url)) void shell.openExternal(url);
      return { action: "deny" };
    });

    wc.on("did-start-loading", push);
    wc.on("did-stop-loading", push);
    // A page that really arrived ends an error (a failed load commits an error page of Chromium's own instead).
    const arrived = (clears: boolean) => (_e: unknown, url: string) => {
      if (parsePreviewUrl(url)) {
        lastUrl = url;
        if (clears) lastError = null;
      }
      push();
    };
    wc.on("did-navigate", arrived(true));
    wc.on("did-navigate-in-page", arrived(false));
    wc.on("page-title-updated", push);
    wc.on("did-fail-load", (_e, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      lastError = code === ERR_CONNECTION_REFUSED ? { kind: "refused", text: "Connection refused" } : { kind: "failed", text: description || "Could not load the page" };
      push();
    });
    wc.on("render-process-gone", () => {
      lastError = { kind: "failed", text: "The preview stopped working" };
      push();
    });

    win.contentView.addChildView(v);
    made.add({ view: v, win });
    view = v;
    host = win;
    mode = want;
    visible = true;
    place();
    return v;
  }

  // The app's own page loaded again (a sign-in link, a reload): its preview state is gone, so the preview goes too.
  const watched = new WeakSet<BrowserWindow>();
  const watch = (win: BrowserWindow) => {
    if (watched.has(win)) return;
    watched.add(win);
    win.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument && host === win) close();
    });
    win.on("closed", () => {
      if (host === win) close();
    });
  };

  ipcMain.handle("preview:open", async (e, raw: unknown, rawBounds: unknown) => {
    const win = opts.getWindow();
    const url = parsePreviewUrl(raw);
    if (!trusted(e) || !win || !url) return { ok: false as const };
    watch(win);
    const b = cleanBounds(rawBounds);
    if (b) bounds = b;
    // An address the run server handed out opens in the strict mode; the page cannot choose the mode.
    const want: PreviewMode = opts.run.owns(url) ? "run" : "localhost";
    const v = view && host === win && mode === want ? view : (close(), await create(win, want));
    if (!v) return { ok: false as const }; // closed or replaced while it was being made
    lastError = null;
    lastUrl = url;
    void v.webContents.loadURL(url).catch(() => undefined); // failures arrive as did-fail-load
    push();
    return { ok: true as const, url };
  });
  ipcMain.on("preview:bounds", (e, raw: unknown) => {
    const b = cleanBounds(raw);
    if (!trusted(e) || !b) return;
    bounds = b;
    place();
  });
  // Hiding hands back a picture of the page for the space it leaves, so a dialog does not blank it.
  ipcMain.handle("preview:visible", async (e, show: unknown) => {
    if (!trusted(e) || !view) return null;
    if (show === true) {
      visible = true;
      place();
      return null;
    }
    let shot: string | null = null;
    try {
      const image = await view.webContents.capturePage();
      shot = image.isEmpty() ? null : `data:image/jpeg;base64,${image.toJPEG(75).toString("base64")}`;
    } catch {
      /* no picture */
    }
    visible = false;
    place();
    return shot;
  });
  // `quiet`: a retry in the background (the page keeps showing its error until the address answers).
  ipcMain.on("preview:reload", (e, quiet: unknown) => {
    if (!trusted(e) || !view) return;
    const wc = view.webContents;
    // After a failed load there is no page to reload: load the address again.
    if (lastError) void wc.loadURL(lastUrl).catch(() => undefined);
    else wc.reloadIgnoringCache();
    if (quiet !== true) {
      lastError = null;
      push();
    }
  });
  ipcMain.on("preview:back", (e) => {
    if (trusted(e) && view?.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack();
  });
  ipcMain.on("preview:forward", (e) => {
    if (trusted(e) && view?.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward();
  });
  ipcMain.on("preview:close", (e) => {
    if (trusted(e)) close();
  });
  ipcMain.handle("preview:get", (e) => (trusted(e) ? stateOf() : null));
  ipcMain.on("preview:external", (e) => {
    // A shared page's address carries the run server's token: in the person's own browser it would run with no wall at all.
    if (!trusted(e) || !view || mode === "run") return;
    const url = parsePreviewUrl(lastUrl);
    if (url) void shell.openExternal(url);
  });
  ipcMain.handle("preview:scan", async (e) => {
    if (!trusted(e)) return [];
    const open = await Promise.all(PREVIEW_PORTS.map((p) => portOpen(p)));
    return PREVIEW_PORTS.filter((_, i) => open[i]);
  });
  ipcMain.handle("preview:clear", async (e) => {
    if (!trusted(e)) return false;
    const s = preview();
    await Promise.all([s.clearStorageData(), s.clearCache()]).catch(() => undefined);
    return true;
  });

  app.on("before-quit", () => opts.run.stop());

  return { close };
}
