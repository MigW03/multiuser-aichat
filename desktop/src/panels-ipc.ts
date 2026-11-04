import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { originOf } from "./folder-host.ts";
import { PanelError, PanelStore } from "./panels-store.ts";
import type { PanelFull, PanelListItem } from "@mc/shared";

// Wires custom panels to the app window. Panels belong to the signed-in person and one project, and live only in this app's
// folder on this computer. The page may list, read, rename, reorder and save a panel's own data. Deleting a panel or its
// saved data asks in a window the app opens itself, which the page cannot click. Creating and changing a panel is not offered
// here: it comes only from a draft the person approves (added with the AI tools).

export type PanelResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function setupPanels(opts: { allowedOrigin: string; getWindow: () => BrowserWindow | null; currentUser: () => string | null }) {
  const store = new PanelStore(join(app.getPath("userData"), "panels"));
  void store.ensureRoot().catch(() => undefined);

  const changed = (projectId: string) => opts.getWindow()?.webContents.send("panels:changed", projectId);
  const trusted = (e: IpcMainInvokeEvent) => originOf(e.senderFrame?.url) === opts.allowedOrigin;
  /** The signed-in person, when the caller is the app's own page. */
  const me = (e: IpcMainInvokeEvent): string | null => (trusted(e) ? opts.currentUser() : null);

  /** Runs one request for the signed-in person; a refusal becomes plain text for the page, never a stack trace. */
  async function run<T>(e: IpcMainInvokeEvent, job: (user: string) => Promise<T>): Promise<PanelResult<T>> {
    const user = me(e);
    if (!user) return { ok: false, error: "Sign in first." };
    try {
      return { ok: true, value: await job(user) };
    } catch (err) {
      if (err instanceof PanelError) return { ok: false, error: err.message };
      console.error("[panels]", err instanceof Error ? err.message : err);
      return { ok: false, error: "That didn't work on this computer." };
    }
  }

  async function confirm(message: string, detail: string, button: string): Promise<boolean> {
    const options = { type: "warning" as const, title: "Nido", message, detail, buttons: ["Cancel", button], defaultId: 0, cancelId: 0, noLink: true };
    const win = opts.getWindow();
    const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return r.response === 1;
  }

  const str = (v: unknown) => (typeof v === "string" ? v : "");

  ipcMain.handle("panels:list", (e, projectId: unknown): Promise<PanelResult<PanelListItem[]>> => run(e, (u) => store.list(u, str(projectId))));
  ipcMain.handle("panels:get", (e, projectId: unknown, panelId: unknown): Promise<PanelResult<PanelFull>> => run(e, (u) => store.get(u, str(projectId), str(panelId))));

  ipcMain.handle("panels:save-state", (e, projectId: unknown, panelId: unknown, state: unknown) =>
    run(e, async (u) => {
      await store.saveState(u, str(projectId), str(panelId), state);
    }),
  );

  ipcMain.handle("panels:rename", (e, projectId: unknown, panelId: unknown, name: unknown) =>
    run(e, async (u) => {
      const meta = await store.rename(u, str(projectId), str(panelId), name);
      changed(str(projectId));
      return meta;
    }),
  );

  ipcMain.handle("panels:set-icon", (e, projectId: unknown, panelId: unknown, icon: unknown) =>
    run(e, async (u) => {
      const meta = await store.setIcon(u, str(projectId), str(panelId), icon);
      changed(str(projectId));
      return meta;
    }),
  );

  ipcMain.handle("panels:move", (e, projectId: unknown, panelId: unknown, delta: unknown) =>
    run(e, async (u) => {
      await store.move(u, str(projectId), str(panelId), delta);
      changed(str(projectId));
    }),
  );

  ipcMain.handle("panels:undo", (e, projectId: unknown, panelId: unknown) =>
    run(e, async (u) => {
      const meta = await store.undo(u, str(projectId), str(panelId));
      changed(str(projectId));
      return meta;
    }),
  );

  ipcMain.handle("panels:clear-state", (e, projectId: unknown, panelId: unknown) =>
    run(e, async (u) => {
      const full = await store.get(u, str(projectId), str(panelId));
      if (!(await confirm(`Clear the saved data of "${full.meta.name}"?`, "Its ticks, notes and inputs are removed from this computer. The panel itself stays. This cannot be undone.", "Clear data"))) return false;
      if (opts.currentUser() !== u) throw new PanelError("bad_request", "You were signed out.");
      await store.clearState(u, str(projectId), str(panelId));
      changed(str(projectId));
      return true;
    }),
  );

  ipcMain.handle("panels:delete", (e, projectId: unknown, panelId: unknown) =>
    run(e, async (u) => {
      const items = await store.list(u, str(projectId));
      const item = items.find((p) => p.id === str(panelId).toLowerCase());
      if (!item) throw new PanelError("not_found", "That panel doesn't exist on this computer.");
      const name = "broken" in item ? "this unreadable panel" : `"${item.name}"`;
      if (!(await confirm(`Delete ${name}?`, "Removes the panel and its saved ticks and notes from this computer. This cannot be undone.", "Delete"))) return false;
      if (opts.currentUser() !== u) throw new PanelError("bad_request", "You were signed out.");
      await store.delete(u, str(projectId), str(panelId));
      changed(str(projectId));
      return true;
    }),
  );

  return store;
}
