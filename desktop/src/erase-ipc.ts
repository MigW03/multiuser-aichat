import { app, BrowserWindow, dialog, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import { rmSync } from "node:fs";
import { ERASE_APPROVAL_MS, ERASE_DETAIL, ERASE_MESSAGE, safeToErase } from "./erase-data.ts";
import { originOf } from "./folder-host.ts";

// Erasing is two steps so the page can't skip the person's answer: `erase:confirm` asks in a window the app opens itself (the
// page cannot click it) and, only if the person says yes, remembers that for a minute; `erase:run` does nothing without that.
// The page signs the person out between the two. The folder is deleted as the app quits, when nothing has it open any more.

export function setupErase(opts: { allowedOrigin: string; getWindow: () => BrowserWindow | null }) {
  let approvedAt = 0;
  let target: string | null = null;
  const trusted = (e: IpcMainInvokeEvent) => originOf(e.senderFrame?.url) === opts.allowedOrigin;

  ipcMain.handle("erase:confirm", async (e): Promise<boolean> => {
    if (!trusted(e)) return false;
    const options = { type: "warning" as const, title: "Erase Nido data", message: ERASE_MESSAGE, detail: ERASE_DETAIL, buttons: ["Cancel", "Erase and quit"], defaultId: 0, cancelId: 0, noLink: true };
    const win = opts.getWindow();
    const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    approvedAt = r.response === 1 ? Date.now() : 0;
    return approvedAt > 0;
  });

  ipcMain.handle("erase:run", async (e): Promise<boolean> => {
    if (!trusted(e) || approvedAt === 0 || Date.now() - approvedAt > ERASE_APPROVAL_MS) return false;
    approvedAt = 0;
    const folder = app.getPath("userData");
    if (!safeToErase(folder, app.getPath("appData"))) return false;
    target = folder;
    await session.defaultSession.clearStorageData().catch(() => undefined);
    await session.defaultSession.clearCache().catch(() => undefined);
    app.quit();
    return true;
  });

  // Last thing before the process ends: Chromium has finished writing, so the folder can go. Retries cover a file still held briefly (Windows).
  app.on("quit", () => {
    if (!target) return;
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      console.error("[erase] could not remove the data folder:", err instanceof Error ? err.message : err);
    }
  });
}
