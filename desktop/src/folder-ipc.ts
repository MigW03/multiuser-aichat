import { classifyCommand, FOLDER_LIMITS as L, type AllowedCommand, type ChangePreview, type FolderCaps, type FolderResponse, type ScriptsInfo } from "@mc/shared";
import { app, BrowserWindow, dialog, ipcMain, Notification, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AllowStore, boundTexts, offerable } from "./folder-allow.ts";
import { Approvals, type AllowVerdict, type PendingView } from "./folder-approvals.ts";
import { stageChange } from "./folder-changes.ts";
import { stageExec } from "./folder-exec.ts";
import { listScripts, longRunningRefusal, ScriptRunner, stageScript } from "./folder-scripts.ts";
import { stageGitChange } from "./folder-git.ts";
import { FolderError, isHiddenName, validateRoot } from "./folder-fs.ts";
import { workerSearch } from "./folder-grep.ts";
import { FolderConn, isUuid, originOf, serverSocketUrl, type FolderState, type HostSession } from "./folder-host.ts";
import { nameItems, servedItems, summaryName, type Item, type ItemSpec, type ItemStatus } from "./folder-items.ts";

// Wires this person's shared files to the app window. The page can: say who is signed in and which projects they belong
// to, ask what is shared, open the native "choose" dialog (or hand over what was dropped on it), remove an item and
// stop sharing. It can never name a path or read a file: items are chosen in a native dialog or dropped by the person,
// and read only for requests that arrive from the chat server for items the host or an admin approved.

type Link = { items: ItemSpec[]; userId: string; caps?: FolderCaps };
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
      const valid = items
        .filter((i): i is ItemSpec => typeof i?.abs === "string" && (i.kind === "dir" || i.kind === "file"))
        .slice(0, L.items)
        .map((i) => ({ abs: i.abs, kind: i.kind, key: typeof i.key === "string" && i.key.length >= 1 && i.key.length <= 64 ? i.key : randomUUID() }));
      if (valid.length) out[projectId] = { items: valid, userId: l.userId, ...(l.caps?.edit === true || l.caps?.git === true || l.caps?.exec === true ? { caps: { edit: l.caps.edit === true, git: l.caps.git === true, exec: l.caps.exec === true } } : {}) };
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

/** `syncing`: the server has not answered for this item yet. `pending`: waiting for the host or an admin. */
export type ItemView = { name: string; kind: "dir" | "file"; key: string; status: "syncing" | "pending" | "active" };
export type FolderInfo = { linked: boolean; name: string | null; items: ItemView[]; state: FolderState; caps: FolderCaps; /** Why the server refused, when it did. */ error: string | null };
const NO_CAPS: FolderCaps = { edit: false, git: false, exec: false };
const EMPTY: FolderInfo = { linked: false, name: null, items: [], state: "off", caps: NO_CAPS, error: null };
type PickResult = { ok: true; name: string; items: FolderInfo["items"]; skipped: string[] } | { ok: false; error: string | null };

export function setupFolderHost(opts: { allowedOrigin: string; getWindow: () => BrowserWindow | null }) {
  let links: Links = {};
  let session: HostSession | null = null;
  const conns = new Map<string, FolderConn>();
  /** What the server last said about each item (new name, approval), per project. Not stored: it is asked for on every connection. */
  const assigned = new Map<string, Map<string, ItemStatus>>();
  // Packaged, the worker is kept outside app.asar (asarUnpack in package.json): worker threads load from the real disk.
  const search = workerSearch(join(__dirname, "folder-worker.cjs").replace(/app\.asar([\\/])/, "app.asar.unpacked$1"));
  const ready = loadLinks().then((l) => {
    links = l;
  });

  // Only the app's own page may use these calls (not an iframe or a page it navigated to).
  const trusted = (e: IpcMainInvokeEvent) => originOf(e.senderFrame?.url) === opts.allowedOrigin;
  const changed = (projectId: string) => opts.getWindow()?.webContents.send("folder:changed", projectId);
  /** What may be served: approved items only, under the names the project gave them. */
  const itemsOf = (projectId: string): Item[] => servedItems(links[projectId]?.items ?? [], assigned.get(projectId));
  /** Everything shared from here, for the server to record. The names are suggestions; the server decides. */
  const report = (projectId: string) => nameItems(links[projectId]?.items ?? []).flatMap((i) => (i.key ? [{ key: i.key, name: i.name, kind: i.kind }] : []));
  /** Every item with the name and approval the server last gave it, for the page. */
  const viewOf = (projectId: string): ItemView[] =>
    nameItems(links[projectId]?.items ?? []).flatMap((i) => {
      const a = i.key ? assigned.get(projectId)?.get(i.key) : undefined;
      return i.key ? [{ name: a?.name ?? i.name, kind: i.kind, key: i.key, status: a?.status ?? ("syncing" as const) }] : [];
    });
  const mine = (projectId: string) => !!links[projectId] && !!session && links[projectId]!.userId === session.userId;
  const capsOf = (projectId: string): FolderCaps => {
    const c = mine(projectId) ? links[projectId]!.caps : undefined;
    return c ? { edit: c.edit === true, git: c.git === true, exec: c.exec === true } : NO_CAPS;
  };

  /** The scripts that run from the Scripts tab. The page hears that something changed and asks for the state. */
  const scripts = new ScriptRunner((projectId) => opts.getWindow()?.webContents.send("folder:scripts-changed", projectId));
  /** The approval id of each Run click that waits for the host (so the row's Cancel can withdraw it), by project, folder and script. */
  const scriptRequests = new Map<string, string>();
  const scriptKey = (projectId: string, key: string, name: string) => `${projectId}\n${key}\n${name}`;

  // Commands the host chose to always allow (folder-allow.ts). The page can list and revoke them; only the native confirmation window adds one.
  const allow = new AllowStore(join(app.getPath("userData"), "always-allowed.json"));
  const allowChanged = (projectId: string) => opts.getWindow()?.webContents.send("folder:allow-changed", projectId);
  const approvalKey = (projectId: string, id: string) => `${projectId}\n${id}`;
  /** The package.json script text a command depends on, as the host is shown it, and the rule that matched a command, by request. */
  const boundOf = new Map<string, string[]>();
  const ruleOf = new Map<string, string>();

  // Proposed AI changes wait here for the host's click. The page learns of them through these events.
  const approvals = new Approvals({
    onAdd: (view) => {
      opts.getWindow()?.webContents.send("folder:approval", view);
      const win = opts.getWindow();
      if (Notification.isSupported() && !(win?.isFocused() ?? false) && !view.change.script) {
        const note = new Notification({ title: "The AI wants to change a file", body: `${view.askedBy} · ${view.change.path}` });
        note.on("click", () => {
          win?.show();
          win?.focus();
        });
        note.show();
      }
    },
    onGone: (projectId, id) => {
      boundOf.delete(approvalKey(projectId, id));
      opts.getWindow()?.webContents.send("folder:approval-gone", { projectId, id });
    },
    stillAllowed: (projectId, kind) => capsOf(projectId)[kind === "files" ? "edit" : kind],
    // A command runs only after the person confirms in a window the app itself shows: the page cannot click it.
    confirm: async (view) => {
      const flags = classifyCommand([view.change.command ?? "", view.change.script?.body ?? "", ...(view.change.script?.around ?? []), ...(boundOf.get(approvalKey(view.projectId, view.id)) ?? [])].join("\n")).map((f) => `• ${f.label}`);
      const script = view.change.script;
      const detail = [
        view.change.command ?? "", // the whole command, never cut: what is confirmed is what runs
        ...(boundOf.get(approvalKey(view.projectId, view.id)) ?? []).map((t) => `Package script, as written in package.json: ${t}`),
        ...(script ? [`Script "${script.name}" in package.json runs: ${script.body}`, ...(script.around ?? []).map((a) => `Also runs ${a}`)] : []),
        "",
        `Folder: ${view.change.workdir ? view.change.workdir : "the shared folder"}`,
        script ? "Time limit: none. It runs in the background until it ends or you press Stop." : `Time limit: ${view.change.timeoutSec ?? 0} seconds`,
        script ? "Started by: you, with the Run button" : `Asked for by: ${view.askedBy}`,
        ...(flags.length ? ["", "Looks like it:", ...flags] : []),
        "",
        "It runs with your own user's rights. Nothing limits what it can read, change or send.",
      ].join("\n");
      const win = opts.getWindow();
      // The always-allow box is offered only when the app judged the command plain enough; it starts unticked and Cancel stays the default.
      const options = {
        type: "warning" as const,
        title: script ? "Run this script?" : "Run this command?",
        message: script ? "Run this script on your computer?" : "Run this command on your computer?",
        detail,
        buttons: ["Cancel", script ? "Run script" : "Run command"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        ...(view.canAlwaysAllow ? { checkboxLabel: `Always allow this exact ${script ? "script" : "command"} in this folder. It will run next time without asking.`, checkboxChecked: false } : {}),
      };
      const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      if (r.response !== 1) return false;
      return view.canAlwaysAllow && r.checkboxChecked ? "always" : true;
    },
    allow: {
      check: async (projectId, staged): Promise<AllowVerdict> => {
        const command = staged.change.command ?? "";
        const bound = await boundTexts(staged.cwd, command);
        const k = approvalKey(projectId, staged.id);
        if (!offerable(command, bound) || !capsOf(projectId).exec) return "no";
        const rule = await allow.match(projectId, staged.cwd, command, bound);
        if (rule) {
          ruleOf.set(k, rule.id);
          return "auto";
        }
        // A script the Scripts tab runs shows its own text already; for any other command that runs a package script, the window shows it too.
        if (!staged.change.script && bound.length > 0) boundOf.set(k, bound);
        return "offer";
      },
      remember: async (view, staged) => {
        const command = staged.change.command ?? "";
        const bound = await boundTexts(staged.cwd, command);
        const shown = boundOf.get(approvalKey(view.projectId, view.id)) ?? bound;
        // package.json changed while the window was open: what was shown is not what would be remembered.
        if (shown.length !== bound.length || shown.some((t, i) => t !== bound[i])) return;
        if (await allow.add({ projectId: view.projectId, cwd: staged.cwd, folder: staged.change.workdir ?? "", command, bound, script: !!staged.change.script })) allowChanged(view.projectId);
      },
      ran: (view, res) => {
        const k = approvalKey(view.projectId, view.id);
        const ruleId = ruleOf.get(k);
        ruleOf.delete(k);
        if (ruleId) void allow.used(ruleId).then(() => allowChanged(view.projectId));
        const win = opts.getWindow();
        win?.webContents.send("folder:auto-ran", { projectId: view.projectId, id: view.id, ruleId: ruleId ?? null, command: view.change.command ?? "", folder: view.change.workdir ?? "", script: !!view.change.script, ok: res.ok, at: Date.now() });
        if (Notification.isSupported() && !(win?.isFocused() ?? false)) new Notification({ title: "Ran a command you always allowed", body: `${view.change.command ?? ""} · ${view.change.workdir ?? ""}` }).show();
      },
    },
  });

  /** A name for the card: what the server says the asker is called, without anything that could pass for UI. */
  // eslint-disable-next-line no-control-regex
  const label = (v: unknown) =>
    (typeof v === "string" ? v : "Someone")
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]+/g, " ")
      .trim()
      .slice(0, 60) || "Someone";

  async function propose(projectId: string, req: unknown, preview: (change: ChangePreview) => void): Promise<FolderResponse | null> {
    const r = (req ?? {}) as { id?: unknown; askedBy?: unknown; readFiles?: unknown };
    if (typeof r.id !== "string") return null;
    const id = r.id;
    const op = (req as { op?: unknown }).op;
    const git = op === "git_change";
    const exec = op === "exec";
    const allowed = exec ? capsOf(projectId).exec : git ? capsOf(projectId).git : capsOf(projectId).edit;
    if (!allowed) return { id, ok: false, code: "disabled", message: exec ? "This person has not allowed commands." : git ? "This person has not allowed git." : "This person has not allowed AI changes to files." };
    // A dev server or watcher is not started from chat: it would sit on the one command slot until its time limit, out of sight. The Scripts tab runs those.
    if (exec) {
      const refusal = await longRunningRefusal(itemsOf(projectId), (req as { command?: unknown }).command);
      if (refusal) return { id, ok: false, code: "long_running", message: refusal };
    }
    // One command at a time per project: a second is refused while one waits or runs.
    if (exec && approvals.execBusy(projectId)) return { id, ok: false, code: "busy", message: "A command is already waiting for its owner or running. Wait for it to finish." };
    if (approvals.count(projectId) >= L.proposals) return { id, ok: false, code: "busy", message: "Several changes are already waiting for the owner. Wait for them to be decided." };
    try {
      const staged = exec ? await stageExec(itemsOf(projectId), req as never) : git ? await stageGitChange(itemsOf(projectId), req as never) : await stageChange(itemsOf(projectId), req as never);
      preview(staged.change);
      const readFiles = typeof r.readFiles === "number" && Number.isFinite(r.readFiles) ? Math.min(1000, Math.max(0, Math.floor(r.readFiles))) : 0;
      return await approvals.propose(projectId, staged, { askedBy: label(r.askedBy), readFiles });
    } catch (err) {
      if (err instanceof FolderError) return { id, ok: false, code: err.code, message: err.message };
      console.error("[folder] could not prepare a change:", err instanceof Error ? err.message : err);
      return { id, ok: false, code: "failed", message: "The change couldn't be prepared." };
    }
  }

  /** Opens a connection for every project this person hosts and shares something from here; closes the rest. */
  function reconcile() {
    const wsUrl = session ? serverSocketUrl(session.serverUrl, app.isPackaged) : null;
    for (const [projectId, conn] of conns) {
      if (!session || !wsUrl || !session.projects.includes(projectId) || !mine(projectId)) {
        scripts.stopProject(projectId);
        conn.close();
        conns.delete(projectId);
        changed(projectId);
      }
    }
    if (!session || !wsUrl) return;
    for (const projectId of session.projects) {
      if (!mine(projectId) || conns.has(projectId)) continue;
      const conn = new FolderConn({
        projectId,
        wsUrl,
        getToken: () => session?.token ?? "",
        getItems: () => itemsOf(projectId),
        getReport: () => report(projectId),
        onItems: (items) => void applyItems(projectId, items),
        onItemsError: (code) => {
          const win = opts.getWindow();
          win?.webContents.send("folder:items-error", { projectId, code });
        },
        search,
        onState: () => changed(projectId),
        getCaps: () => capsOf(projectId),
        propose: (req, preview) => propose(projectId, req, preview),
        cancel: (id) => approvals.cancel(projectId, id),
        cancelAll: () => approvals.closeProject(projectId),
      });
      conns.set(projectId, conn);
      changed(projectId);
    }
  }

  /** The server's answer about the items. Something it knew before and no longer lists was removed by the host or an admin: it stops being shared here too. */
  async function applyItems(projectId: string, items: ({ key: string } & ItemStatus)[]) {
    const before = assigned.get(projectId);
    const next = new Map(items.map((i) => [i.key, { name: i.name, status: i.status }] as const));
    assigned.set(projectId, next);
    const link = links[projectId];
    if (link) {
      const gone = new Set([...(before?.keys() ?? [])].filter((k) => !next.has(k)));
      for (const key of gone) scripts.stopItem(projectId, key);
      if (gone.size > 0) {
        const keep = link.items.filter((i) => !(i.key && gone.has(i.key)));
        if (keep.length !== link.items.length) {
          if (keep.length === 0) {
            const { [projectId]: _gone, ...rest } = links;
            links = rest;
          } else links = { ...links, [projectId]: { ...link, items: keep } };
          await saveLinks(links);
          approvals.closeProject(projectId); // what a waiting change pointed at may be gone
          await allow.revokeProject(projectId);
          allowChanged(projectId);
          reconcile();
        }
      }
    }
    changed(projectId);
  }

  const info = (projectId: string): FolderInfo => {
    if (!mine(projectId)) return EMPTY;
    const items = viewOf(projectId);
    const conn = conns.get(projectId);
    return { linked: true, name: summaryName(nameItems(links[projectId]!.items)), items, state: conn?.state ?? "off", caps: capsOf(projectId), error: conn?.error ?? null };
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
      Array.isArray(s.projects) &&
      s.projects.length <= 500 &&
      s.projects.every(isUuid)
    ) {
      const tokenChanged = session?.token !== s.token;
      session = { serverUrl: s.serverUrl, token: s.token, userId: s.userId, projects: [...s.projects] };
      reconcile();
      if (tokenChanged) for (const c of conns.values()) c.tokenChanged();
    } else {
      session = null;
      reconcile();
    }
  });

  ipcMain.handle("folder:get", async (e, projectId: unknown): Promise<FolderInfo> => {
    if (!trusted(e) || !isUuid(projectId)) return EMPTY;
    await ready;
    return info(projectId);
  });

  /**
   * Adds checked items to what this person shares in a project, tells the server (which names them and, for a member,
   * asks the host or an admin), and answers the page. `skipped` names picks that could not be shared.
   */
  async function addItems(projectId: string, picks: ItemSpec[], skipped: string[], lastError: string | null): Promise<PickResult> {
    const current = mine(projectId) ? links[projectId]!.items : [];
    const added: ItemSpec[] = [];
    for (const pick of picks) {
      if ([...current, ...added].some((i) => i.abs === pick.abs)) continue; // already shared
      if (current.length + added.length >= L.items) {
        skipped.push(basename(pick.abs));
        lastError = `You can share up to ${L.items} folders and files in a project.`;
        continue;
      }
      added.push({ abs: pick.abs, kind: pick.kind, key: randomUUID() });
    }
    if (added.length === 0) return { ok: false, error: lastError };
    links = { ...links, [projectId]: { ...(links[projectId] ?? {}), items: [...current, ...added], userId: session!.userId } };
    await saveLinks(links);
    reconcile(); // the first item of a project opens its connection, which reports it in its hello
    conns.get(projectId)?.reportItems();
    changed(projectId);
    const now = info(projectId);
    return { ok: true, name: now.name!, items: now.items, skipped };
  }

  const canShareIn = (projectId: string) => !!session && session.projects.includes(projectId);

  // Adds folders or files picked in the native dialog. The server answers over the connection and the page hears about it through folder:changed.
  ipcMain.handle("folder:pick", async (e, projectId: unknown, kind: unknown): Promise<PickResult> => {
    if (!trusted(e) || !isUuid(projectId) || (kind !== "folder" && kind !== "files")) return { ok: false, error: "Invalid request." };
    await ready;
    if (!canShareIn(projectId)) return { ok: false, error: "You can only share files in a project you belong to." };
    const current = mine(projectId) ? links[projectId]!.items : [];
    if (current.length >= L.items) return { ok: false, error: `You can share up to ${L.items} folders and files in a project. Remove one first.` };
    const win = opts.getWindow();
    const options: OpenDialogOptions =
      kind === "folder"
        ? { title: "Choose folders to share with this project", buttonLabel: "Share", properties: ["openDirectory", "multiSelections"] }
        : { title: "Choose files to share with this project", buttonLabel: "Share", properties: ["openFile", "multiSelections"] };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: null };

    const specs: ItemSpec[] = [];
    const skipped: string[] = [];
    let lastError: string | null = null;
    for (const p of picked.filePaths) {
      try {
        specs.push({ abs: kind === "folder" ? await validateRoot(p) : await validateFile(p), kind: kind === "folder" ? "dir" : "file" });
      } catch (err) {
        skipped.push(basename(p));
        lastError = err instanceof FolderError ? err.message : "That couldn't be shared.";
      }
    }
    return addItems(projectId, specs, skipped, lastError);
  });

  // Dropped on the panel. The page's drop listener (folder-preload.ts) hands over the real paths of what the person dragged in
  // from their file system, and they wait here, checked, until the page has shown the "who can see this" notice if one is due
  // and the person's choice comes back as drop-commit. The page only ever sees names.
  const staged = new Map<string, { specs: ItemSpec[]; skipped: string[]; lastError: string | null; at: number }>();
  const STAGE_MS = 5 * 60_000;
  const MAX_DROPPED = 50;

  ipcMain.handle("folder:drop-stage", async (e, projectId: unknown, paths: unknown): Promise<{ ok: true; items: { name: string; kind: "dir" | "file" }[]; skipped: string[] } | { ok: false; error: string }> => {
    if (!trusted(e) || !isUuid(projectId) || !Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p.length > 0 && p.length < 4096)) return { ok: false, error: "Invalid request." };
    await ready;
    if (!canShareIn(projectId)) return { ok: false, error: "You can only share files in a project you belong to." };
    const specs: ItemSpec[] = [];
    const skipped: string[] = [];
    let lastError: string | null = null;
    for (const p of (paths as string[]).slice(0, MAX_DROPPED)) {
      try {
        const st = await stat(p);
        if (!st.isDirectory() && !st.isFile()) throw new FolderError("not_a_file", "Only folders and files can be shared.");
        specs.push({ abs: st.isDirectory() ? await validateRoot(p) : await validateFile(p), kind: st.isDirectory() ? "dir" : "file" });
      } catch (err) {
        skipped.push(basename(p));
        lastError = err instanceof FolderError ? err.message : "That couldn't be shared.";
      }
    }
    if (specs.length === 0) return { ok: false, error: lastError ?? "Nothing to share." };
    staged.set(projectId, { specs, skipped, lastError, at: Date.now() });
    return { ok: true, items: specs.map((s) => ({ name: basename(s.abs), kind: s.kind })), skipped };
  });

  ipcMain.handle("folder:drop-commit", async (e, projectId: unknown): Promise<PickResult> => {
    if (!trusted(e) || !isUuid(projectId)) return { ok: false, error: "Invalid request." };
    await ready;
    const s = staged.get(projectId);
    staged.delete(projectId);
    if (!s || Date.now() - s.at > STAGE_MS || !canShareIn(projectId)) return { ok: false, error: "Drop them again to share them." };
    return addItems(projectId, s.specs, s.skipped, s.lastError);
  });

  ipcMain.handle("folder:drop-cancel", async (e, projectId: unknown) => {
    if (trusted(e) && isUuid(projectId)) staged.delete(projectId);
  });

  // Takes one item out of what this person shares. The server hears about it over the connection.
  ipcMain.handle("folder:remove", async (e, projectId: unknown, name: unknown): Promise<{ name: string | null }> => {
    if (!trusted(e) || !isUuid(projectId) || typeof name !== "string") return { name: null };
    await ready;
    if (!mine(projectId)) return { name: null };
    const gone = viewOf(projectId).find((i) => i.name === name);
    if (!gone) return { name: info(projectId).name };
    const keep = links[projectId]!.items.filter((i) => i.key !== gone.key);
    scripts.stopItem(projectId, gone.key);
    const before = conns.get(projectId);
    if (keep.length === 0) {
      const { [projectId]: _gone, ...rest } = links;
      links = rest;
    } else links = { ...links, [projectId]: { ...links[projectId]!, items: keep } };
    await saveLinks(links);
    assigned.get(projectId)?.delete(gone.key);
    approvals.closeProject(projectId); // what a waiting change pointed at may be gone
    await allow.revokeProject(projectId); // a folder that comes back under the same name is a new folder: its commands ask again
    allowChanged(projectId);
    before?.reportItems(); // before reconcile closes the connection, when nothing is left
    reconcile();
    changed(projectId);
    return { name: keep.length ? summaryName(nameItems(keep)) : null };
  });

  // This person's switch for AI changes to what they share. Off by default; only for a project they share from this computer.
  ipcMain.handle("folder:set-caps", async (e, projectId: unknown, caps: unknown): Promise<FolderInfo | null> => {
    if (!trusted(e) || !isUuid(projectId)) return null;
    await ready;
    if (!mine(projectId)) return null;
    // Only the keys that are sent change; anything else stays as it was.
    const given = (caps ?? {}) as { edit?: unknown; git?: unknown; exec?: unknown };
    const before = capsOf(projectId);
    const next: FolderCaps = {
      edit: typeof given.edit === "boolean" ? given.edit : before.edit,
      git: typeof given.git === "boolean" ? given.git : before.git,
      exec: typeof given.exec === "boolean" ? given.exec : before.exec,
    };
    // Turning commands on is confirmed in the app's own window, which the page cannot click. Turning anything off just happens.
    if (next.exec && !before.exec) {
      const win = opts.getWindow();
      const options = {
        type: "warning" as const,
        title: "Let the AI propose commands?",
        message: "Let the AI propose commands on your computer?",
        detail:
          "In this project's chats the AI will be able to propose shell commands, asked for by anyone in the project. Each one appears in this app with the exact command, and you confirm every single one in a window like this before it runs. Nothing runs on its own, unless you tick “always allow” for a plain command in that window: then that exact command, in that folder, runs without asking for 30 days, until you revoke it in Project settings.\n\nThere is no sandbox: an approved command runs with your user's rights and can read or change anything you can, including files outside the shared folder. Its output goes into the chat and to the AI provider. You can switch this off any time.",
        buttons: ["Cancel", "Allow proposals"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      if (r.response !== 1) return info(projectId);
    }
    const { caps: _old, ...rest } = links[projectId]!;
    links = { ...links, [projectId]: { ...rest, ...(next.edit || next.git || next.exec ? { caps: next } : {}) } };
    await saveLinks(links);
    if (!next.edit) approvals.closeProject(projectId, "The owner turned off AI changes.", "files"); // what was waiting is withdrawn at once
    if (!next.git) approvals.closeProject(projectId, "The owner turned off git.", "git");
    if (!next.exec) {
      approvals.closeProject(projectId, "The owner turned off commands.", "exec"); // and a command that is running is stopped
      scripts.stopProject(projectId); // and so are the scripts
    }
    conns.get(projectId)?.capsChanged();
    changed(projectId);
    return info(projectId);
  });

  ipcMain.handle("folder:approvals", async (e): Promise<PendingView[]> => {
    if (!trusted(e)) return [];
    return approvals.list();
  });

  // The host's click. Approving writes the file; the server cannot do either.
  ipcMain.handle("folder:decide", async (e, projectId: unknown, id: unknown, approve: unknown): Promise<boolean> => {
    if (!trusted(e) || !isUuid(projectId) || typeof id !== "string" || typeof approve !== "boolean") return false;
    await ready;
    if (!mine(projectId)) return false;
    return approvals.decide(projectId, id, approve);
  });

  // ---- Always-allowed commands. The page can list and revoke them; it cannot add one (only the native window can).
  ipcMain.handle("folder:allow-list", async (e, projectId: unknown): Promise<AllowedCommand[]> => {
    if (!trusted(e) || !isUuid(projectId)) return [];
    await ready;
    return mine(projectId) ? allow.list(projectId) : [];
  });
  ipcMain.handle("folder:allow-revoke", async (e, projectId: unknown, ruleId: unknown): Promise<boolean> => {
    if (!trusted(e) || !isUuid(projectId) || typeof ruleId !== "string" || ruleId.length > 64) return false;
    await ready;
    if (!mine(projectId)) return false;
    const done = await allow.revoke(projectId, ruleId);
    allowChanged(projectId);
    return done;
  });
  ipcMain.handle("folder:allow-revoke-all", async (e, projectId: unknown): Promise<void> => {
    if (!trusted(e) || !isUuid(projectId)) return;
    await ready;
    if (!mine(projectId)) return;
    await allow.revokeProject(projectId);
    allowChanged(projectId);
  });

  // ---- The Scripts tab: package.json scripts of the folders this person shares from this computer.
  const NO_SCRIPTS: ScriptsInfo = { scripts: [], runs: [] };
  const isName = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 64;

  // `list` false: only how the runs are doing (package.json is not read again), for while a script is printing.
  ipcMain.handle("folder:scripts-get", async (e, projectId: unknown, list: unknown): Promise<ScriptsInfo> => {
    if (!trusted(e) || !isUuid(projectId)) return NO_SCRIPTS;
    await ready;
    if (!mine(projectId)) return NO_SCRIPTS;
    return { scripts: list === false ? [] : await listScripts(itemsOf(projectId)), runs: scripts.runs(projectId) };
  });

  // The Run button. It only asks: the request waits in the approval dock, and the script starts when the owner approves it there and confirms in the app's own window.
  ipcMain.handle("folder:script-run", async (e, projectId: unknown, key: unknown, name: unknown): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!trusted(e) || !isUuid(projectId) || !isName(key) || !isName(name)) return { ok: false, error: "That script can't be run." };
    await ready;
    if (!mine(projectId)) return { ok: false, error: "Scripts run from the computer that shares the folder." };
    if (!capsOf(projectId).exec) return { ok: false, error: "Commands are off for this project. Turn them on in Project settings." };
    if (scripts.isWaiting(projectId, key, name)) return { ok: true };
    if (approvals.execBusy(projectId)) return { ok: false, error: "A command is already waiting for you. Decide on it first." };
    if (approvals.count(projectId) >= L.proposals) return { ok: false, error: "Several requests are already waiting for you. Decide on them first." };
    const id = `script-${randomUUID()}`;
    try {
      const staged = await stageScript(itemsOf(projectId), { id, key, name }, (cwd, command) => scripts.start(projectId, key, name, command, cwd));
      const k = scriptKey(projectId, key, name);
      scriptRequests.set(k, id);
      scripts.setWaiting(projectId, key, name, true);
      void approvals.propose(projectId, staged, { askedBy: "You", readFiles: 0 }).then((res) => {
        scriptRequests.delete(k);
        scripts.setWaiting(projectId, key, name, false);
        // Declining or letting it expire is the person's own doing; anything else is told on the row.
        if (!res.ok && res.code !== "denied" && res.code !== "expired") scripts.fail(projectId, key, name, res.message);
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof FolderError) return { ok: false, error: err.message };
      console.error("[folder] could not prepare a script:", err instanceof Error ? err.message : err);
      return { ok: false, error: "The script couldn't be prepared." };
    }
  });

  // Withdraws a Run click that has not been approved yet.
  ipcMain.handle("folder:script-cancel", async (e, projectId: unknown, key: unknown, name: unknown): Promise<void> => {
    if (!trusted(e) || !isUuid(projectId) || !isName(key) || !isName(name) || !mine(projectId)) return;
    const id = scriptRequests.get(scriptKey(projectId, key, name));
    if (id) await approvals.decide(projectId, id, false);
  });

  // Stopping needs no approval: it only ends something this person started.
  ipcMain.handle("folder:script-stop", async (e, projectId: unknown, key: unknown, name: unknown): Promise<boolean> => {
    if (!trusted(e) || !isUuid(projectId) || !isName(key) || !isName(name) || !mine(projectId)) return false;
    return scripts.stop(projectId, key, name);
  });

  ipcMain.handle("folder:script-log", async (e, projectId: unknown, key: unknown, name: unknown): Promise<string | null> => {
    if (!trusted(e) || !isUuid(projectId) || !isName(key) || !isName(name) || !mine(projectId)) return null;
    return scripts.log(projectId, key, name);
  });

  ipcMain.handle("folder:script-clear", async (e, projectId: unknown, key: unknown, name: unknown): Promise<void> => {
    if (trusted(e) && isUuid(projectId) && isName(key) && isName(name) && mine(projectId)) scripts.clearLog(projectId, key, name);
  });

  ipcMain.handle("folder:scripts-seen", async (e, projectId: unknown): Promise<void> => {
    if (trusted(e) && isUuid(projectId) && mine(projectId)) scripts.markSeen(projectId);
  });

  // (Re)connects one project now.
  ipcMain.handle("folder:connect", async (e, projectId: unknown) => {
    if (!trusted(e) || !isUuid(projectId)) return;
    await ready;
    conns.get(projectId)?.close();
    conns.delete(projectId);
    reconcile();
    changed(projectId);
  });

  // Stops sharing everything this person shares in a project.
  ipcMain.handle("folder:unlink", async (e, projectId: unknown) => {
    if (!trusted(e) || !isUuid(projectId)) return;
    await ready;
    if (!(projectId in links)) return;
    const { [projectId]: _gone, ...rest } = links;
    links = rest;
    await saveLinks(links);
    assigned.delete(projectId);
    approvals.closeProject(projectId);
    scripts.stopProject(projectId);
    await allow.revokeProject(projectId);
    allowChanged(projectId);
    conns.get(projectId)?.reportItems(); // an empty list, before reconcile closes the connection
    reconcile();
    changed(projectId);
  });

  app.on("before-quit", () => {
    approvals.closeAll();
    scripts.stopAll();
    for (const c of conns.values()) c.close();
  });
}
