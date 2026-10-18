import { FOLDER_LIMITS as L } from "@mc/shared";
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { FolderError, isHiddenName, validateRoot } from "./folder-fs.ts";
import { workerSearch } from "./folder-grep.ts";
import { FolderConn, isUuid, originOf, serverSocketUrl, type FolderState, type HostSession } from "./folder-host.ts";
import { nameItems, summaryName, type Item, type ItemSpec } from "./folder-items.ts";

// Wires the shared folder to the app window. The page can: say who is signed in and which projects they host,
// ask what is shared, open the native "choose" dialog, remove an item and stop sharing. It can never name a path or
// read a file: items are chosen in a native dialog and read only for requests that arrive from the chat server.

type Link = { items: ItemSpec[]; userId: string };
type Links = Record<string, Link>;

const STORE = () => join(app.getPath("userData"), "shared-folders.json");

async function loadLinks(): Promise<Links> {
  try {
    const parsed = JSON.parse(await readFile(STORE(), "utf8")) as { links?: Record<string, Partial<Link> & { root?: unknown }> };
    const out: Links = {};
    for (const [projectId, l] of Object.entries(parsed.links ?? {})) {
      if (!isUuid(projectId) || !isUuid(l?.userId)) continue;
      // Version 1 kept one folder as `root`.
      const items = Array.isArray(l.items) ? l.items : typeof l.root === "string" ? [{ abs: l.root, kind: "dir" as const }] : [];
      const valid = items.filter((i): i is ItemSpec => typeof i?.abs === "string" && (i.kind === "dir" || i.kind === "file")).slice(0, L.items);
      if (valid.length) out[projectId] = { items: valid, userId: l.userId };
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
  await writeFile(tmp, JSON.stringify({ version: 2, links }), { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600).catch(() => undefined);
}

/** A file the person picked: a plain file that isn't one of the always-hidden kinds (.env, keys, ...). */
async function validateFile(picked: string): Promise<string> {
  let abs: string;
  try {
    abs = await realpath(picked);
    if (!(await lstat(abs)).isFile()) throw new Error("not a file");
  } catch {
    throw new FolderError("not_a_file", "That isn't a file that can be shared.");
  }
  if (isHiddenName(basename(abs), false)) throw new FolderError("excluded", `${basename(abs)} looks like a secret (an env file, a key or similar), so it can't be shared.`);
  return abs;
}

export type FolderInfo = { linked: boolean; name: string | null; items: { name: string; kind: "dir" | "file" }[]; state: FolderState };
type PickResult = { ok: true; name: string; items: FolderInfo["items"]; skipped: string[] } | { ok: false; error: string | null };

export function setupFolderHost(opts: { allowedOrigin: string; getWindow: () => BrowserWindow | null }) {
  let links: Links = {};
  let session: HostSession | null = null;
  const conns = new Map<string, FolderConn>();
  // Packaged, the worker is kept outside app.asar (asarUnpack in package.json): worker threads load from the real disk.
  const search = workerSearch(join(__dirname, "folder-worker.cjs").replace(/app\.asar([\\/])/, "app.asar.unpacked$1"));
  const ready = loadLinks().then((l) => {
    links = l;
  });

  // Only the app's own page may use these calls (not an iframe or a page it navigated to).
  const trusted = (e: IpcMainInvokeEvent) => originOf(e.senderFrame?.url) === opts.allowedOrigin;
  const changed = (projectId: string) => opts.getWindow()?.webContents.send("folder:changed", projectId);
  const itemsOf = (projectId: string): Item[] => nameItems(links[projectId]?.items ?? []);
  const mine = (projectId: string) => !!links[projectId] && !!session && links[projectId]!.userId === session.userId;

  /** Opens a connection for every project this person hosts and shares something from here; closes the rest. */
  function reconcile() {
    const wsUrl = session ? serverSocketUrl(session.serverUrl, app.isPackaged) : null;
    for (const [projectId, conn] of conns) {
      if (!session || !wsUrl || !session.hostProjects.includes(projectId) || !mine(projectId)) {
        conn.close();
        conns.delete(projectId);
        changed(projectId);
      }
    }
    if (!session || !wsUrl) return;
    for (const projectId of session.hostProjects) {
      if (!mine(projectId) || conns.has(projectId)) continue;
      const conn = new FolderConn({
        projectId,
        wsUrl,
        getToken: () => session?.token ?? "",
        getItems: () => itemsOf(projectId),
        search,
        onState: () => changed(projectId),
      });
      conns.set(projectId, conn);
      changed(projectId);
    }
  }

  const info = (projectId: string): FolderInfo => {
    if (!mine(projectId)) return { linked: false, name: null, items: [], state: "off" };
    const items = itemsOf(projectId);
    return { linked: true, name: summaryName(items), items: items.map((i) => ({ name: i.name, kind: i.kind })), state: conns.get(projectId)?.state ?? "off" };
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
    if (!trusted(e) || !isUuid(projectId)) return { linked: false, name: null, items: [], state: "off" };
    await ready;
    return info(projectId);
  });

  // Adds folders or files to what the project shares. The page registers the new name with the server next and
  // then calls folder:connect.
  ipcMain.handle("folder:pick", async (e, projectId: unknown, kind: unknown): Promise<PickResult> => {
    if (!trusted(e) || !isUuid(projectId) || (kind !== "folder" && kind !== "files")) return { ok: false, error: "Invalid request." };
    await ready;
    if (!session || !session.hostProjects.includes(projectId)) return { ok: false, error: "Only the project's host can share files." };
    const current = mine(projectId) ? links[projectId]!.items : [];
    if (current.length >= L.items) return { ok: false, error: `A project can share up to ${L.items} folders and files. Remove one first.` };
    const win = opts.getWindow();
    const options: OpenDialogOptions =
      kind === "folder"
        ? { title: "Choose folders to share with this project", buttonLabel: "Share", properties: ["openDirectory", "multiSelections"] }
        : { title: "Choose files to share with this project", buttonLabel: "Share", properties: ["openFile", "multiSelections"] };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: null };

    const added: ItemSpec[] = [];
    const skipped: string[] = [];
    let lastError: string | null = null;
    for (const p of picked.filePaths) {
      try {
        const abs = kind === "folder" ? await validateRoot(p) : await validateFile(p);
        if ([...current, ...added].some((i) => i.abs === abs)) continue; // already shared
        if (current.length + added.length >= L.items) {
          skipped.push(basename(p));
          lastError = `A project can share up to ${L.items} folders and files.`;
          continue;
        }
        added.push({ abs, kind: kind === "folder" ? "dir" : "file" });
      } catch (err) {
        skipped.push(basename(p));
        lastError = err instanceof FolderError ? err.message : "That couldn't be shared.";
      }
    }
    if (added.length === 0) return { ok: false, error: lastError };
    links = { ...links, [projectId]: { items: [...current, ...added], userId: session.userId } };
    await saveLinks(links);
    changed(projectId);
    const now = info(projectId);
    return { ok: true, name: now.name!, items: now.items, skipped };
  });

  // Takes one item out of what is shared. Returns the new name, or null when nothing is left.
  ipcMain.handle("folder:remove", async (e, projectId: unknown, name: unknown): Promise<{ name: string | null }> => {
    if (!trusted(e) || !isUuid(projectId) || typeof name !== "string") return { name: null };
    await ready;
    if (!mine(projectId)) return { name: null };
    const keep = links[projectId]!.items.filter((_, i) => itemsOf(projectId)[i]?.name !== name);
    if (keep.length === 0) {
      const { [projectId]: _gone, ...rest } = links;
      links = rest;
    } else links = { ...links, [projectId]: { ...links[projectId]!, items: keep } };
    await saveLinks(links);
    reconcile();
    changed(projectId);
    return { name: keep.length ? summaryName(nameItems(keep)) : null };
  });

  // (Re)connects one project now, for example right after its items were registered with the server.
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
