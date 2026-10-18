import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FolderError, folderName, validateRoot } from "./folder-fs.ts";
import { FolderConn, isUuid, serverSocketUrl, type FolderState, type HostSession } from "./folder-host.ts";

// Wires the shared folder to the app window. The page can: say who is signed in and which projects they host,
// ask whether a folder is linked, open the "choose folder" dialog, and unlink. It can never name a path or read
// a file: the folder is chosen in a native dialog and read only for requests that arrive from the chat server.

type Link = { root: string; name: string; userId: string };
type Links = Record<string, Link>;

const STORE = () => join(app.getPath("userData"), "shared-folders.json");

async function loadLinks(): Promise<Links> {
  try {
    const parsed = JSON.parse(await readFile(STORE(), "utf8")) as { links?: Links };
    const out: Links = {};
    for (const [projectId, l] of Object.entries(parsed.links ?? {})) {
      if (isUuid(projectId) && typeof l?.root === "string" && typeof l.name === "string" && isUuid(l.userId)) out[projectId] = { root: l.root, name: l.name, userId: l.userId };
    }
    return out;
  } catch {
    return {};
  }
}

async function saveLinks(links: Links) {
  const file = STORE();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, links }), { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600).catch(() => undefined);
}

export type FolderInfo = { linked: boolean; name: string | null; state: FolderState };

export function setupFolderHost(opts: { allowedOrigin: string; getWindow: () => BrowserWindow | null }) {
  let links: Links = {};
  let session: HostSession | null = null;
  const conns = new Map<string, FolderConn>();
  const ready = loadLinks().then((l) => {
    links = l;
  });

  const trusted = (e: IpcMainInvokeEvent) => {
    try {
      return new URL(e.senderFrame?.url ?? "").origin === opts.allowedOrigin;
    } catch {
      return false;
    }
  };
  const changed = (projectId: string) => opts.getWindow()?.webContents.send("folder:changed", projectId);

  /** Opens a connection for every project this person hosts and has a folder linked for here; closes the rest. */
  function reconcile() {
    const wsUrl = session ? serverSocketUrl(session.serverUrl, app.isPackaged) : null;
    for (const [projectId, conn] of conns) {
      const link = links[projectId];
      if (!session || !wsUrl || !session.hostProjects.includes(projectId) || !link || link.userId !== session.userId) {
        conn.close();
        conns.delete(projectId);
        changed(projectId);
      }
    }
    if (!session || !wsUrl) return;
    for (const projectId of session.hostProjects) {
      const link = links[projectId];
      if (!link || link.userId !== session.userId || conns.has(projectId)) continue;
      const conn = new FolderConn({
        projectId,
        wsUrl,
        root: link.root,
        getToken: () => session?.token ?? "",
        onState: () => changed(projectId),
      });
      conns.set(projectId, conn);
      changed(projectId);
    }
  }

  const info = (projectId: string): FolderInfo => {
    const link = links[projectId];
    const mine = !!link && !!session && link.userId === session.userId;
    return { linked: mine, name: mine ? link!.name : null, state: mine ? (conns.get(projectId)?.state ?? "off") : "off" };
  };

  ipcMain.handle("folder:set-session", async (e, raw: unknown) => {
    if (!trusted(e)) return;
    await ready;
    const s = raw as Partial<HostSession> | null;
    if (
      s &&
      typeof s.serverUrl === "string" &&
      typeof s.token === "string" &&
      s.token.length > 0 &&
      s.token.length <= 4096 &&
      isUuid(s.userId) &&
      Array.isArray(s.hostProjects) &&
      s.hostProjects.length <= 100 &&
      s.hostProjects.every(isUuid)
    ) {
      const tokenChanged = session?.token !== s.token;
      session = { serverUrl: s.serverUrl, token: s.token, userId: s.userId, hostProjects: [...s.hostProjects] };
      reconcile();
      if (tokenChanged) for (const c of conns.values()) c.tokenChanged();
    } else {
      session = null;
      reconcile();
    }
  });

  ipcMain.handle("folder:get", async (e, projectId: unknown): Promise<FolderInfo> => {
    if (!trusted(e) || !isUuid(projectId)) return { linked: false, name: null, state: "off" };
    await ready;
    return info(projectId);
  });

  ipcMain.handle("folder:pick", async (e, projectId: unknown): Promise<{ ok: true; name: string } | { ok: false; error: string | null }> => {
    if (!trusted(e) || !isUuid(projectId)) return { ok: false, error: "Invalid request." };
    await ready;
    if (!session || !session.hostProjects.includes(projectId)) return { ok: false, error: "Only the project's host can share a folder." };
    const win = opts.getWindow();
    const options = { title: "Choose the folder to share with this project", buttonLabel: "Share this folder", properties: ["openDirectory" as const] };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const dir = picked.filePaths[0];
    if (picked.canceled || !dir) return { ok: false, error: null };
    try {
      const root = await validateRoot(dir);
      const name = folderName(root);
      conns.get(projectId)?.close();
      conns.delete(projectId);
      links = { ...links, [projectId]: { root, name, userId: session.userId } };
      await saveLinks(links);
      // Not connected yet: the server only accepts the host's app once the page has registered the folder there,
      // which it does next and then calls folder:connect.
      changed(projectId);
      return { ok: true, name };
    } catch (err) {
      return { ok: false, error: err instanceof FolderError ? err.message : "That folder couldn't be shared." };
    }
  });

  // (Re)connects one project's folder now, for example right after it was registered with the server.
  ipcMain.handle("folder:connect", async (e, projectId: unknown) => {
    if (!trusted(e) || !isUuid(projectId)) return;
    await ready;
    conns.get(projectId)?.close();
    conns.delete(projectId);
    reconcile();
    changed(projectId);
  });

  ipcMain.handle("folder:unlink", async (e, projectId: unknown) => {
    if (!trusted(e) || !isUuid(projectId)) return;
    await ready;
    if (!(projectId in links)) return;
    const { [projectId]: _gone, ...rest } = links;
    links = rest;
    await saveLinks(links);
    reconcile();
    changed(projectId);
  });

  app.on("before-quit", () => {
    for (const c of conns.values()) c.close();
  });
}
