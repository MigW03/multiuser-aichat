import { DESIGN_LIMITS, designSlug, designUnsafe, projectDesignPath, projectDesignSlug, redactSecrets, replaceText, EditMatchError, type DesignReadResult, type DesignVersionList, type DesignWriteResult, type ProjectDesign } from "@mc/shared";
import { randomUUID } from "node:crypto";
import { objectStore, type ObjectStore } from "./r2.ts";
import { admin } from "./supabase.ts";

// A project's designs. The list, the versions and who made them are rows in the database (migration 0024); the HTML of each
// version is one object in R2 under designs/<project>/<design>/<random>.html. Every version is a new object, so a save never
// overwrites what another save wrote: the database decides which save wins (it names the version it was made from), and
// the loser's object is removed again.
//
// Designs come from anyone in a project and the AI, so every save is checked here first: plain text within the size limit,
// no secrets, and nothing active (designUnsafe). The canvas cleans what it draws again (DOMPurify, shadow root).

export type DesignErrorCode = "not_found" | "forbidden" | "stale" | "exists" | "full" | "invalid" | "too_large" | "unsafe" | "secrets" | "no_match" | "ambiguous";

export class DesignError extends Error {
  constructor(
    readonly code: DesignErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type DesignRow = {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  version: number;
  html_key: string;
  bytes: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};
export type DesignVersionRow = { version: number; html_key: string; bytes: number; created_by: string | null; created_at: string };

/** The database side. The functions raise short codes (not_found, forbidden, stale, design_exists, designs_full, ...). */
export interface DesignDb {
  role(userId: string, projectId: string): Promise<string | null>;
  list(projectId: string): Promise<DesignRow[]>;
  bySlug(projectId: string, slug: string): Promise<DesignRow | null>;
  create(userId: string, projectId: string, row: { id: string; slug: string; name: string; key: string; bytes: number }): Promise<void>;
  save(userId: string, designId: string, base: number, key: string, bytes: number): Promise<{ version: number; pruned: string[] }>;
  remove(userId: string, designId: string): Promise<{ purged: string[] }>;
  versions(designId: string): Promise<DesignVersionRow[]>;
}

const CODES: Record<string, [DesignErrorCode, string]> = {
  not_found: ["not_found", "That design doesn't exist, or you don't have access to it."],
  forbidden: ["forbidden", "Only the person who made a design, the host or an admin can delete it."],
  stale: ["stale", "The design changed since it was opened. Read it again."],
  design_exists: ["exists", "A design with that name already exists. Pick another name."],
  designs_full: ["full", `This project has ${DESIGN_LIMITS.perProject} designs already. Delete one first.`],
  invalid_name: ["invalid", "That name isn't valid. Use up to 60 characters, on one line."],
  invalid_scope: ["invalid", "Invalid request."],
};

function fromDb(error: { message?: string } | null | undefined): never {
  const code = (error?.message ?? "").trim();
  const known = CODES[code];
  if (known) throw new DesignError(known[0], known[1]);
  throw new Error(`database: ${code || "unknown error"}`);
}

export function supabaseDesignDb(): DesignDb {
  const COLUMNS = "id, project_id, slug, name, version, html_key, bytes, created_by, updated_by, created_at, updated_at";
  return {
    async role(userId, projectId) {
      const { data, error } = await admin.rpc("project_role_of", { p_user: userId, p_project: projectId });
      if (error) throw new Error(`database: ${error.message}`);
      return (data as string | null) ?? null;
    },
    async list(projectId) {
      const { data, error } = await admin.from("project_designs").select(COLUMNS).eq("project_id", projectId).is("deleted_at", null).order("updated_at", { ascending: false }).limit(DESIGN_LIMITS.perProject);
      if (error) throw new Error(`database: ${error.message}`);
      return (data ?? []) as DesignRow[];
    },
    async bySlug(projectId, slug) {
      const { data, error } = await admin.from("project_designs").select(COLUMNS).eq("project_id", projectId).eq("slug", slug).is("deleted_at", null).maybeSingle();
      if (error) throw new Error(`database: ${error.message}`);
      return (data as DesignRow | null) ?? null;
    },
    async create(userId, projectId, row) {
      const { error } = await admin.rpc("app_design_create", { p_user: userId, p_project: projectId, p_id: row.id, p_slug: row.slug, p_name: row.name, p_key: row.key, p_bytes: row.bytes });
      if (error) fromDb(error);
    },
    async save(userId, designId, base, key, bytes) {
      const { data, error } = await admin.rpc("app_design_save", { p_user: userId, p_design: designId, p_base: base, p_key: key, p_bytes: bytes });
      if (error) fromDb(error);
      const r = data as { version: number; pruned: string[] | null };
      return { version: r.version, pruned: r.pruned ?? [] };
    },
    async remove(userId, designId) {
      const { data, error } = await admin.rpc("app_design_delete", { p_user: userId, p_design: designId });
      if (error) fromDb(error);
      return { purged: (data as { purged: string[] | null }).purged ?? [] };
    },
    async versions(designId) {
      const { data, error } = await admin.from("project_design_versions").select("version, html_key, bytes, created_by, created_at").eq("design_id", designId).order("version", { ascending: false }).limit(DESIGN_LIMITS.versions);
      if (error) throw new Error(`database: ${error.message}`);
      return (data ?? []) as DesignVersionRow[];
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Bytes a design can take: 400,000 characters of up to 3 bytes each (a 4-byte character counts as 2). */
const MAX_BYTES = DESIGN_LIMITS.chars * 3;

/** Where a design's objects live. Both ids are checked, so no key can reach outside its project's designs. */
export function designPrefix(projectId: string, designId?: string): string {
  if (!UUID.test(projectId) || (designId !== undefined && !UUID.test(designId))) throw new DesignError("invalid", "Invalid request.");
  return `designs/${projectId.toLowerCase()}/${designId ? `${designId.toLowerCase()}/` : ""}`;
}

const newKey = (projectId: string, designId: string) => `${designPrefix(projectId, designId)}${randomUUID()}.html`;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Why a design's text can't be saved, as an error, or nothing. */
export function checkDesignText(text: unknown): asserts text is string {
  if (typeof text !== "string") throw new DesignError("invalid", "The design must be text.");
  if (text.length > DESIGN_LIMITS.chars) throw new DesignError("too_large", `A design can be at most ${DESIGN_LIMITS.chars} characters.`);
  if (text.includes("\u0000") || LONE_SURROGATE.test(text)) throw new DesignError("invalid", "The design is not plain text.");
  if (redactSecrets(text) !== text) throw new DesignError("secrets", "The design contains something that looks like a secret (a key, token or password), so it was not saved.");
  const unsafe = designUnsafe(text);
  if (unsafe) throw new DesignError("unsafe", `Designs cannot contain ${unsafe}. Use plain HTML elements with inline styles only.`);
}

/** A design named by its address (`project:landing.design.html`) or, for the AI, by its name ("Landing page"). */
export function slugOf(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const bySlug = projectDesignSlug(ref.trim());
  if (bySlug) return bySlug;
  const name = ref.trim().replace(/\.design\.html$/i, "");
  if (!name || name.length > 200 || name.includes("/") || name.includes(":")) return null;
  return designSlug(name);
}

const toInfo = (r: DesignRow): ProjectDesign => ({ path: projectDesignPath(r.slug), name: r.name, version: r.version, bytes: r.bytes, createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at });

export type Designs = ReturnType<typeof createDesigns>;

export function createDesigns(deps: { db?: DesignDb; store?: () => ObjectStore } = {}) {
  const db = deps.db ?? supabaseDesignDb();
  const store = deps.store ?? objectStore;

  async function member(userId: string, projectId: string) {
    designPrefix(projectId);
    if (!(await db.role(userId, projectId))) throw new DesignError("not_found", CODES.not_found![1]);
  }

  async function find(projectId: string, ref: unknown): Promise<DesignRow> {
    const slug = slugOf(ref);
    const row = slug ? await db.bySlug(projectId, slug) : null;
    if (!row) throw new DesignError("not_found", "That design doesn't exist in this project.");
    return row;
  }

  async function textOf(row: DesignRow, key: string): Promise<string> {
    // The database only takes keys under the design's own prefix; checked again before anything is fetched.
    if (!key.startsWith(designPrefix(row.project_id, row.id))) throw new DesignError("not_found", "That design's saved text is missing.");
    const body = await store().get(key, MAX_BYTES);
    if (!body) throw new DesignError("not_found", "That design's saved text is missing.");
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
  }

  /** Removes objects nobody points at any more. Best effort: a leftover is never reachable (no row names it). */
  function drop(keys: string[]) {
    for (const key of keys) {
      void store()
        .remove(key)
        .catch((e) => console.error("[designs] could not remove an old version:", e instanceof Error ? e.name : "unknown error"));
    }
  }

  async function saveOver(userId: string, row: DesignRow, base: number, text: string): Promise<DesignWriteResult> {
    checkDesignText(text);
    const bytes = new TextEncoder().encode(text);
    const key = newKey(row.project_id, row.id);
    await store().put(key, bytes, { design: row.id });
    try {
      const r = await db.save(userId, row.id, base, key, bytes.byteLength);
      drop(r.pruned);
      return { path: projectDesignPath(row.slug), version: r.version, created: false };
    } catch (e) {
      drop([key]);
      throw e;
    }
  }

  return {
    async list(userId: string, projectId: string): Promise<ProjectDesign[]> {
      await member(userId, projectId);
      return (await db.list(projectId)).map(toInfo);
    },

    async read(userId: string, projectId: string, ref: unknown): Promise<DesignReadResult> {
      await member(userId, projectId);
      const row = await find(projectId, ref);
      return { path: projectDesignPath(row.slug), name: row.name, text: await textOf(row, row.html_key), version: row.version };
    },

    /** A new design. Its address comes from the name; `unique` picks "name-2" and so on when the name is taken. */
    async create(userId: string, projectId: string, name: string, text: string, opts: { unique?: boolean } = {}): Promise<DesignWriteResult> {
      await member(userId, projectId);
      const clean = name.trim().replace(/\s+/g, " ");
      if (!clean || clean.length > DESIGN_LIMITS.nameChars || /[\u0000-\u001f\u007f]/.test(clean)) throw new DesignError("invalid", CODES.invalid_name![1]);
      checkDesignText(text);
      const bytes = new TextEncoder().encode(text);
      const base = designSlug(clean);
      for (let n = 1; n <= (opts.unique ? 20 : 1); n++) {
        const slug = n === 1 ? base : `${base.slice(0, DESIGN_LIMITS.nameChars - 4).replace(/-+$/, "")}-${n}`;
        const id = randomUUID();
        const key = newKey(projectId, id);
        await store().put(key, bytes, { design: id });
        try {
          await db.create(userId, projectId, { id, slug, name: clean, key, bytes: bytes.byteLength });
          return { path: projectDesignPath(slug), version: 1, created: true };
        } catch (e) {
          drop([key]);
          if (!(e instanceof DesignError && e.code === "exists") || !opts.unique) throw e;
        }
      }
      throw new DesignError("exists", CODES.design_exists![1]);
    },

    /** Replaces a whole design. `base` is the version the text was made from. */
    async save(userId: string, projectId: string, ref: unknown, text: string, base: number): Promise<DesignWriteResult> {
      await member(userId, projectId);
      return saveOver(userId, await find(projectId, ref), base, text);
    },

    /** Replaces exact text in the current version, like the AI's edit tool, and saves at once. */
    async edit(userId: string, projectId: string, ref: unknown, oldString: string, newString: string, replaceAll = false): Promise<DesignWriteResult> {
      await member(userId, projectId);
      const row = await find(projectId, ref);
      const before = await textOf(row, row.html_key);
      let next: string;
      try {
        next = replaceText(before, oldString, newString, replaceAll);
      } catch (e) {
        if (e instanceof EditMatchError) throw new DesignError(e.code === "bad_request" ? "invalid" : e.code, e.message.replace("the file", "the design"));
        throw e;
      }
      return saveOver(userId, row, row.version, next);
    },

    async remove(userId: string, projectId: string, ref: unknown): Promise<{ path: string }> {
      await member(userId, projectId);
      const row = await find(projectId, ref);
      const { purged } = await db.remove(userId, row.id);
      for (const id of purged) {
        void store()
          .removePrefix(designPrefix(projectId, id))
          .catch((e) => console.error("[designs] could not remove a deleted design's versions:", e instanceof Error ? e.name : "unknown error"));
      }
      return { path: projectDesignPath(row.slug) };
    },

    async versions(userId: string, projectId: string, ref: unknown): Promise<DesignVersionList> {
      await member(userId, projectId);
      const row = await find(projectId, ref);
      const list = await db.versions(row.id);
      return { current: row.version, versions: list.map((v) => ({ version: v.version, by: v.created_by, at: v.created_at, bytes: v.bytes })) };
    },

    /** Saves an older version's text as the newest version. */
    async restore(userId: string, projectId: string, ref: unknown, version: number, base: number): Promise<DesignWriteResult> {
      await member(userId, projectId);
      const row = await find(projectId, ref);
      const old = (await db.versions(row.id)).find((v) => v.version === version);
      if (!old) throw new DesignError("not_found", "That version is no longer kept.");
      return saveOver(userId, row, base, await textOf(row, old.html_key));
    },
  };
}
