import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { originOf } from "./folder-host.ts";
import { PanelDrafts, type DraftView } from "./panels-drafts.ts";
import { PanelError, PanelStore } from "./panels-store.ts";
import { isReadTool, PANEL_LIMITS, type PanelFull, type PanelListItem, type SourceRead } from "@mc/shared";
import { FolderError } from "./folder-fs.ts";
import type { McpHost } from "./mcp-host.ts";

// Wires custom panels to the app window. Panels belong to the signed-in person and one project, and live only in this app's
// folder on this computer. The page may list, read, rename, reorder and save a panel's own data. Deleting a panel or its
// saved data asks in a window the app opens itself, which the page cannot click. Creating and changing a panel is not offered
// here: it comes only from a draft the person approves (added with the AI tools).

export type PanelResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function setupPanels(opts: { allowedOrigin: string; getWindow: () => BrowserWindow | null; currentUser: () => string | null; /** The person's own tool servers on this computer. */ mcp: McpHost }) {
  const store = new PanelStore(join(app.getPath("userData"), "panels"));
  void store.ensureRoot().catch(() => undefined);

  const changed = (projectId: string) => opts.getWindow()?.webContents.send("panels:changed", projectId);
  // What the AI proposes waits here for the person's click. Told to the page only for the person who is signed in.
  const drafts = new PanelDrafts(store, (userId, projectId) => {
    if (opts.currentUser() === userId) opts.getWindow()?.webContents.send("panels:drafts-changed", projectId);
  });
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
      drafts.forgetPanel(u, str(projectId), str(panelId));
      changed(str(projectId));
      return true;
    }),
  );

  // A panel's number comes from one read of one of the person's own tool servers. The page names the panel and the source;
  // the app looks up what that source is (saved when the person approved the panel), checks it is a read, and calls it.
  // null: it isn't a server on this computer, so the page asks the person's remote servers instead.
  ipcMain.handle("panels:read-source", (e, projectId: unknown, panelId: unknown, sourceId: unknown): Promise<PanelResult<SourceRead | null>> =>
    run(e, async (u) => {
      const full = await store.get(u, str(projectId), str(panelId));
      const src = full.meta.sources.find((s) => s.id === sourceId);
      if (!src) throw new PanelError("not_found", "That panel has no such source.");
      if (!isReadTool(src.tool)) throw new PanelError("bad_request", "Panels can only read.");
      const server = (await opts.mcp.view(u)).servers.find((s) => s.name === src.server);
      if (!server) return null;
      const need = (n: Exclude<SourceRead, { ok: true }>["need"]): SourceRead => ({ ok: false, need: n, server: src.server });
      if (!server.enabled) return need("setup");
      if (server.status === "starting") await opts.mcp.idle();
      const now = (await opts.mcp.view(u)).servers.find((s) => s.name === src.server);
      if (!now || now.status === "failed" || now.status === "off") return need("retry");
      const tool = now.tools.find((t) => t.name === src.tool);
      if (!tool || !tool.usable || !tool.enabled) return need("unavailable");
      try {
        const r = await opts.mcp.call({ server: src.server, tool: src.tool, args: src.args });
        // What a tool returns is text from whatever ran: capped here, drawn as plain text, never sent to the AI.
        const text = r.text.length > PANEL_LIMITS.resultChars ? r.text.slice(0, PANEL_LIMITS.resultChars) : r.text;
        return r.isError ? need("retry") : { ok: true, text, truncated: r.truncated || text.length < r.text.length };
      } catch (err) {
        if (err instanceof FolderError) return need(err.code === "busy" ? "busy" : err.code === "mcp_unavailable" ? "unavailable" : "retry");
        throw err;
      }
    }),
  );

  ipcMain.handle("panels:drafts", (e, projectId: unknown): Promise<PanelResult<DraftView[]>> => run(e, async (u) => drafts.list(u, str(projectId))));

  // The person's click on Add / Update. The app saves the draft it kept; the page names only the draft.
  ipcMain.handle("panels:draft-commit", (e, projectId: unknown, id: unknown) =>
    run(e, async (u) => {
      const r = await drafts.commit(u, str(projectId), str(id));
      changed(str(projectId));
      return r;
    }),
  );

  ipcMain.handle("panels:draft-discard", (e, projectId: unknown, id: unknown) =>
    run(e, async (u) => {
      drafts.discard(u, str(projectId), str(id));
    }),
  );

  /**
   * What the chat server may ask about THIS person's panels, for an answer they asked for. It can list them and put a proposal in
   * front of the person; that is all. Nothing it asks makes, changes or deletes a panel.
   */
  async function request(userId: string, raw: unknown): Promise<unknown> {
    const r = (raw ?? {}) as { panelOp?: unknown; projectId?: unknown; panelId?: unknown; draft?: unknown };
    const projectId = str(r.projectId);
    try {
      if (r.panelOp === "list") {
        const all = await store.list(userId, projectId);
        const list = await Promise.all(
          all.map(async (p) => {
            if ("broken" in p) return { id: p.id, unreadable: true };
            return { id: p.id, name: p.name, rev: p.rev, sources: p.sources.map((s) => ({ id: s.id, label: s.label, server: s.server, tool: s.tool })), functions: p.functions.map((f) => ({ id: f.id, label: f.label, kind: f.kind })) };
          }),
        );
        return { ok: true, list };
      }
      if (r.panelOp === "draft") {
        const d = await drafts.propose(userId, projectId, r.panelId === undefined ? undefined : str(r.panelId), r.draft);
        return { ok: true, draftId: d.id, kind: d.kind };
      }
      if (r.panelOp === "delete_request") {
        const d = await drafts.proposeDelete(userId, projectId, str(r.panelId));
        return { ok: true, draftId: d.id };
      }
      return { ok: false, error: "Unknown request." };
    } catch (err) {
      if (err instanceof PanelError) return { ok: false, error: err.message.slice(0, 280) };
      throw err;
    }
  }

  return { store, request, signedOut: (userId: string) => drafts.clearUser(userId) };
}
