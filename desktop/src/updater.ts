import { app, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { autoUpdater } from "electron-updater";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initialState, installMode, reduce, releaseUrl, shouldAutoCheck, shouldAutoDownload, type UpdateEvent, type UpdateState } from "./update-logic.ts";

// Over-the-air updates. The feed is the project's GitHub releases (latest.yml / latest-mac.yml next to the installers); electron-updater
// fetches it over https and refuses a download whose sha512 differs from the one listed there.
//
// Set to true once the Mac build is signed with an Apple Developer ID and notarized: only then can macOS swap the app by itself.
// Until then a Mac build finds updates but sends the person to the download page.
const MAC_SIGNED = false;

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

type Options = { allowedOrigin: string; getWindow: () => BrowserWindow | null };

export function setupUpdater(opts: Options) {
  const settingsFile = () => join(app.getPath("userData"), "update-settings.json");
  const readAuto = (): boolean => {
    try {
      return (JSON.parse(readFileSync(settingsFile(), "utf8")) as { auto?: unknown }).auto !== false;
    } catch {
      return true;
    }
  };

  const mode = installMode(process.platform, MAC_SIGNED);
  let state = initialState(app.getVersion(), mode, readAuto(), app.isPackaged);
  let checking = false;

  const trusted = (e: IpcMainInvokeEvent) => {
    const win = opts.getWindow();
    if (!win || e.sender !== win.webContents) return false;
    try {
      return new URL(e.senderFrame?.url ?? "").origin === opts.allowedOrigin;
    } catch {
      return false;
    }
  };

  const push = () => {
    const win = opts.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send("update:state", state);
  };
  const apply = (event: UpdateEvent) => {
    state = reduce(state, event);
    push();
  };

  ipcMain.handle("update:get", (e) => (trusted(e) ? state : null));
  if (state.status === "unavailable") return;

  autoUpdater.autoDownload = false;
  // A downloaded update installs the next time the app quits, even if the person never presses Restart.
  autoUpdater.autoInstallOnAppQuit = mode === "auto";
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on("checking-for-update", () => apply({ type: "checking" }));
  autoUpdater.on("update-not-available", () => apply({ type: "none", at: Date.now() }));
  autoUpdater.on("update-available", (info) => {
    apply({ type: "found", version: info.version, at: Date.now() });
    if (state.status === "available" && shouldAutoDownload(state)) void startDownload();
  });
  autoUpdater.on("download-progress", (p) => apply({ type: "downloading", percent: p.percent }));
  autoUpdater.on("update-downloaded", (info) => apply({ type: "ready", version: info.version }));
  autoUpdater.on("error", () => {
    // Failures while downloading surface through startDownload(); a check reports through check().
  });

  async function check(quiet: boolean) {
    if (checking) return;
    checking = true;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      apply({ type: "failed", quiet });
    } finally {
      checking = false;
    }
  }

  async function startDownload() {
    if (state.mode !== "auto" || (state.status !== "available" && state.status !== "error")) return;
    try {
      apply({ type: "downloading", percent: 0 });
      await autoUpdater.downloadUpdate();
    } catch {
      apply({ type: "failed", quiet: false });
    }
  }

  ipcMain.handle("update:check", async (e) => {
    if (!trusted(e)) return null;
    await check(false);
    return state;
  });
  ipcMain.handle("update:download", async (e) => {
    if (!trusted(e) || state.status !== "available") return null;
    if (state.mode === "manual") {
      // No self-install here: open the release page in the person's browser. The address is built from a checked version only.
      const url = releaseUrl(state.version);
      if (url) void shell.openExternal(url);
    } else await startDownload();
    return state;
  });
  ipcMain.handle("update:install", (e) => {
    if (!trusted(e) || state.status !== "ready" || state.mode !== "auto") return false;
    // setImmediate: let this reply go out before the windows close.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  });
  ipcMain.handle("update:set-auto", (e, on: unknown) => {
    if (!trusted(e) || typeof on !== "boolean") return state;
    try {
      writeFileSync(settingsFile(), JSON.stringify({ auto: on }));
    } catch {
      /* the choice only lasts this run */
    }
    apply({ type: "auto", on });
    // Switched on while a version waits: take it now.
    if (on && state.status === "available") void startDownload();
    return state;
  });

  setTimeout(() => void check(true), FIRST_CHECK_MS).unref();
  setInterval(() => {
    if (shouldAutoCheck(state)) void check(true);
  }, CHECK_EVERY_MS).unref();
}
