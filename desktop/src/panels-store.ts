import { checkDraft, checkState, functions, icon, PANEL_LIMITS as L, PanelError, sources, uuid, UUID, validName, fail, type PanelFull, type PanelListItem, type PanelMeta } from "@mc/shared";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Custom panels on this computer. A panel is a few small files, kept per signed-in person and per project:
//   <root>/<user id>/<project id>/<panel id>/panel.json     name, icon, revision, data sources, functions
//                                            view.openui    the wireframe (gen UI spec); drawn by the app, never run
//                                            state.json     what the panel saved for itself: ticks, notes, inputs
//                                            prev/          the version before the last change (panel.json, view.openui, state.json)
//   <root>/<user id>/<project id>/index.json                the order of the tabs
// Nothing here is sent to the chat server. Every id is a UUID the app made (or checked), so no path can leave the folder, and
// a link or an odd file planted in the folder is skipped, never followed. Everything read back is checked again: a damaged or
// hand-edited panel shows as "unreadable" and can be deleted, it never runs or crashes the list.

export { checkDraft, checkState, PanelError };

const FORMAT = 1;

// ------------------------------------------------------------------ files

type Stored = { format: number; id: string; name: string; icon: string; rev: number; createdAt: number; updatedAt: number; sources: unknown; functions: unknown };

/** A real, plain file or folder: never a link. */
async function plain(path: string, dir: boolean): Promise<boolean> {
  try {
    const st = await lstat(path);
    return !st.isSymbolicLink() && (dir ? st.isDirectory() : st.isFile());
  } catch {
    return false;
  }
}

/** Reads a plain file of at most `max` bytes, or null (missing, a link, too big). */
async function readText(path: string, max: number): Promise<string | null> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink() || !st.isFile() || st.size > max) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, content, { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function parseMeta(raw: string | null, id: string): PanelMeta | null {
  if (raw === null) return null;
  try {
    const m = JSON.parse(raw) as Stored;
    if (m.format !== FORMAT || m.id !== id) return null;
    const rev = Number(m.rev);
    if (typeof m.rev !== "number" || !Number.isInteger(rev) || rev < 1) return null;
    return { id, name: validName(m.name), icon: icon(m.icon), rev, createdAt: Number(m.createdAt) || 0, updatedAt: Number(m.updatedAt) || 0, sources: sources(m.sources), functions: functions(m.functions) };
  } catch {
    return null;
  }
}

const metaText = (meta: PanelMeta): string => JSON.stringify({ format: FORMAT, ...meta } satisfies Stored);

/** `missing`: there is no file (fine: no saved data yet). A file that is there but can't be read (a link, too big) is damaged. */
async function readState(path: string): Promise<Record<string, unknown> | null> {
  try {
    await lstat(path);
  } catch {
    return {};
  }
  return parseState(await readText(path, L.stateBytes + 1_000));
}

function parseState(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    return checkState(JSON.parse(raw));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the store

export class PanelStore {
  /** Writes to one panel (or one project's order) run one after another. */
  private chain = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  private locked<T>(key: string, job: () => Promise<T>): Promise<T> {
    const run = (this.chain.get(key) ?? Promise.resolve()).catch(() => undefined).then(job);
    const tail = run.catch(() => undefined);
    this.chain.set(key, tail);
    void tail.then(() => {
      if (this.chain.get(key) === tail) this.chain.delete(key);
    });
    return run;
  }

  private projectDir(userId: unknown, projectId: unknown): string {
    return join(this.root, uuid(userId, "The user"), uuid(projectId, "The project"));
  }
  private panelDir(userId: unknown, projectId: unknown, panelId: unknown): string {
    return join(this.projectDir(userId, projectId), uuid(panelId, "The panel"));
  }

  private async order(project: string): Promise<string[]> {
    const raw = await readText(join(project, "index.json"), 10_000);
    try {
      const o = (JSON.parse(raw ?? "{}") as { order?: unknown }).order;
      return Array.isArray(o) ? o.filter((v): v is string => typeof v === "string" && UUID.test(v)).slice(0, 100) : [];
    } catch {
      return [];
    }
  }
  private async saveOrder(project: string, order: string[]): Promise<void> {
    await writeAtomic(join(project, "index.json"), JSON.stringify({ order }));
  }

  /** The panels of one project, in tab order. A folder that can't be read is listed as broken so the person can delete it. */
  async list(userId: string, projectId: string): Promise<PanelListItem[]> {
    const project = this.projectDir(userId, projectId);
    let names: string[];
    try {
      names = await readdir(project);
    } catch {
      return [];
    }
    const found = new Map<string, PanelListItem>();
    for (const name of names) {
      if (!UUID.test(name) || name !== name.toLowerCase()) continue; // the app only ever makes lowercase ids
      const id = name;
      const dir = join(project, name);
      if (!(await plain(dir, true))) continue;
      const meta = parseMeta(await readText(join(dir, "panel.json"), 50_000), id);
      found.set(id, meta ?? { id, broken: true });
    }
    const ordered = (await this.order(project)).filter((id) => found.has(id));
    const stamp = (p: PanelListItem) => ("broken" in p ? Number.MAX_SAFE_INTEGER : p.createdAt);
    const rest = [...found.values()].filter((p) => !ordered.includes(p.id)).sort((a, b) => stamp(a) - stamp(b));
    return [...ordered.map((id) => found.get(id)!), ...rest];
  }

  async get(userId: string, projectId: string, panelId: string): Promise<PanelFull> {
    const dir = this.panelDir(userId, projectId, panelId);
    const id = String(panelId).toLowerCase();
    if (!(await plain(dir, true))) return fail("not_found", "That panel doesn't exist on this computer.");
    const meta = parseMeta(await readText(join(dir, "panel.json"), 50_000), id);
    const spec = await readText(join(dir, "view.openui"), L.viewBytes);
    const state = await readState(join(dir, "state.json"));
    if (!meta || spec === null || state === null) return fail("broken", "That panel's files are damaged. You can delete it.");
    return { meta, view: spec, state, hasPrev: await plain(join(dir, "prev"), true) };
  }

  async create(userId: string, projectId: string, rawDraft: unknown): Promise<PanelMeta> {
    const draft = checkDraft(rawDraft);
    const project = this.projectDir(userId, projectId);
    return this.locked(project, async () => {
      const existing = await this.list(userId, projectId);
      if (existing.length >= L.perProject) fail("too_many", `A project can have ${L.perProject} custom panels. Delete one first.`);
      this.assertFreeName(existing, draft.name, null);
      const id = randomUUID();
      const now = Date.now();
      const meta: PanelMeta = { id, name: draft.name, icon: draft.icon, rev: 1, createdAt: now, updatedAt: now, sources: draft.sources, functions: draft.functions };
      const dir = join(project, id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      try {
        await writeAtomic(join(dir, "view.openui"), draft.view);
        await writeAtomic(join(dir, "state.json"), "{}");
        await writeAtomic(join(dir, "panel.json"), metaText(meta)); // last: a panel without panel.json is not listed as working
        await this.saveOrder(project, [...(await this.order(project)).filter((x) => x !== id), id]);
      } catch (err) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
      return meta;
    });
  }

  /** A new version of a panel. The version it replaces (with its saved data) is kept once; the saved data carries over as it is. */
  async update(userId: string, projectId: string, panelId: string, rawDraft: unknown): Promise<PanelMeta> {
    const draft = checkDraft(rawDraft);
    const dir = this.panelDir(userId, projectId, panelId);
    return this.locked(dir, async () => {
      const current = await this.get(userId, projectId, panelId);
      this.assertFreeName(await this.list(userId, projectId), draft.name, current.meta.id);
      await this.keepPrev(dir);
      const meta: PanelMeta = { id: current.meta.id, name: draft.name, icon: draft.icon, rev: current.meta.rev + 1, createdAt: current.meta.createdAt, updatedAt: Date.now(), sources: draft.sources, functions: draft.functions };
      await writeAtomic(join(dir, "view.openui"), draft.view);
      await writeAtomic(join(dir, "panel.json"), metaText(meta));
      return meta;
    });
  }

  /** Replaces prev/ with a copy of the current files. */
  private async keepPrev(dir: string): Promise<void> {
    const prev = join(dir, "prev");
    await rm(prev, { recursive: true, force: true });
    await mkdir(prev, { mode: 0o700 });
    for (const f of ["panel.json", "view.openui", "state.json"]) {
      const t = await readText(join(dir, f), L.stateBytes + 1_000);
      if (t !== null) await writeAtomic(join(prev, f), t);
    }
  }

  async undo(userId: string, projectId: string, panelId: string): Promise<PanelMeta> {
    const dir = this.panelDir(userId, projectId, panelId);
    return this.locked(dir, async () => {
      const current = await this.get(userId, projectId, panelId);
      const prev = join(dir, "prev");
      if (!(await plain(prev, true))) return fail("no_prev", "There is no earlier version.");
      const meta = parseMeta(await readText(join(prev, "panel.json"), 50_000), current.meta.id);
      const spec = await readText(join(prev, "view.openui"), L.viewBytes);
      const state = await readState(join(prev, "state.json"));
      if (!meta || spec === null || state === null) return fail("broken", "The earlier version is damaged.");
      this.assertFreeName(await this.list(userId, projectId), meta.name, meta.id);
      await writeAtomic(join(dir, "view.openui"), spec);
      await writeAtomic(join(dir, "state.json"), JSON.stringify(state));
      await writeAtomic(join(dir, "panel.json"), metaText({ ...meta, updatedAt: Date.now() }));
      await rm(prev, { recursive: true, force: true }); // one step back only
      return { ...meta, updatedAt: Date.now() };
    });
  }

  async saveState(userId: string, projectId: string, panelId: string, rawState: unknown): Promise<void> {
    const state = checkState(rawState);
    const dir = this.panelDir(userId, projectId, panelId);
    await this.locked(dir, async () => {
      if (!(await plain(dir, true))) fail("not_found", "That panel doesn't exist on this computer.");
      await writeAtomic(join(dir, "state.json"), JSON.stringify(state));
    });
  }

  async clearState(userId: string, projectId: string, panelId: string): Promise<void> {
    await this.saveState(userId, projectId, panelId, {});
  }

  async rename(userId: string, projectId: string, panelId: string, rawName: unknown): Promise<PanelMeta> {
    return this.changeMeta(userId, projectId, panelId, async (meta, all) => {
      const name = validName(rawName);
      this.assertFreeName(all, name, meta.id);
      return { ...meta, name };
    });
  }

  async setIcon(userId: string, projectId: string, panelId: string, rawIcon: unknown): Promise<PanelMeta> {
    return this.changeMeta(userId, projectId, panelId, async (meta) => ({ ...meta, icon: icon(rawIcon) }));
  }

  private async changeMeta(userId: string, projectId: string, panelId: string, change: (meta: PanelMeta, all: PanelListItem[]) => Promise<PanelMeta>): Promise<PanelMeta> {
    const dir = this.panelDir(userId, projectId, panelId);
    return this.locked(dir, async () => {
      const current = await this.get(userId, projectId, panelId);
      const next = await change(current.meta, await this.list(userId, projectId));
      await writeAtomic(join(dir, "panel.json"), metaText(next)); // a rename is not a new version: no rev bump, nothing to undo
      return next;
    });
  }

  /** Moves a tab one step: -1 left, +1 right. */
  async move(userId: string, projectId: string, panelId: string, delta: unknown): Promise<void> {
    if (delta !== -1 && delta !== 1) return fail("bad_request", "A panel moves one step left or right.");
    const project = this.projectDir(userId, projectId);
    const id = uuid(panelId, "The panel");
    await this.locked(project, async () => {
      const order = (await this.list(userId, projectId)).map((p) => p.id);
      const at = order.indexOf(id);
      if (at < 0) return fail("not_found", "That panel doesn't exist on this computer.");
      const to = at + delta;
      if (to < 0 || to >= order.length) return;
      [order[at], order[to]] = [order[to]!, order[at]!];
      await this.saveOrder(project, order);
    });
  }

  /** Removes the panel, its saved data and its earlier version. */
  async delete(userId: string, projectId: string, panelId: string): Promise<void> {
    const project = this.projectDir(userId, projectId);
    const dir = this.panelDir(userId, projectId, panelId);
    const id = String(panelId).toLowerCase();
    await this.locked(dir, async () => {
      if (!(await plain(dir, true))) return fail("not_found", "That panel doesn't exist on this computer.");
      await rm(dir, { recursive: true, force: true });
      await this.locked(project, async () => this.saveOrder(project, (await this.order(project)).filter((x) => x !== id)));
    });
  }

  private assertFreeName(all: PanelListItem[], name: string, selfId: string | null): void {
    const lower = name.toLowerCase();
    if (all.some((p) => !("broken" in p) && p.id !== selfId && p.name.toLowerCase() === lower)) fail("name_taken", `A panel called "${name}" already exists in this project.`);
  }

  /** Makes sure the folder exists with owner-only rights. Called once at start. */
  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => undefined);
  }
}
