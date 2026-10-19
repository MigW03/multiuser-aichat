import { FOLDER_LIMITS as L, type FolderCaps, type FolderEntry, type FolderGlobResult, type FolderResponse, type FolderSearchResult } from "@mc/shared";
import { lstat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { FolderError, folderName, listDir, readText, splitPath, type Target } from "./folder-fs.ts";
import { gitRead } from "./folder-git.ts";

// What a project shares: up to 20 folders and files, picked one by one by the host. One folder alone is shared as
// is (paths start inside it, like src/index.ts). Anything else is shown as a top level made of the picked items,
// each under its own name (my-app/src/index.ts, notes.md).

export type ItemSpec = { abs: string; kind: "dir" | "file" };
export type Item = ItemSpec & { name: string };
/** glob and grep, which the app runs in a worker thread it can stop (folder-grep.ts). */
export type Search = {
  glob: (targets: Target[], pattern: unknown, opts: { hidden?: unknown; limit?: unknown }) => Promise<FolderGlobResult>;
  grep: (targets: Target[], pattern: unknown, opts: { include?: unknown; literal?: unknown; caseSensitive?: unknown; limit?: unknown }) => Promise<FolderSearchResult>;
};

/** Gives each item the name it is shown under: its own name, with " (2)", " (3)"... when two are called the same. */
export function nameItems(specs: ItemSpec[]): Item[] {
  const used = new Set<string>();
  return specs.slice(0, L.items).map((spec) => {
    const base = folderName(spec.abs);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    used.add(name.toLowerCase());
    return { ...spec, name };
  });
}

/** The name the project sees for everything shared: the item's name, or "first + N more". */
export function summaryName(items: Item[]): string {
  if (items.length === 0) return "Shared files";
  const first = items[0]!.name;
  return (items.length === 1 ? first : `${first} + ${items.length - 1} more`).slice(0, L.nameChars);
}

const transparent = (items: Item[]) => items.length === 1 && items[0]!.kind === "dir";

export const itemTarget = (item: Item, rest: string[]): Target => {
  if (item.kind === "dir") return { root: item.abs, start: rest, prefix: item.name };
  if (rest.length > 0) throw new FolderError("not_found", "That file or folder doesn't exist in the shared folder.");
  return { root: dirname(item.abs), start: [basename(item.abs)], prefix: item.name, single: true };
};

/** Where a path points: the shared top level, or a place inside one item. */
export function resolve(items: Item[], path: unknown): Target | "top" {
  const parts = splitPath(path ?? "");
  if (transparent(items)) return { root: items[0]!.abs, start: parts, prefix: "" };
  if (parts.length === 0) return "top";
  const item = items.find((i) => i.name === parts[0]);
  if (!item) throw new FolderError("not_found", "That file or folder doesn't exist in the shared folder.");
  return itemTarget(item, parts.slice(1));
}

export const under = (prefix: string, path: string) => [prefix, path].filter(Boolean).join("/");

async function topLevel(items: Item[]): Promise<FolderEntry[]> {
  const entries = await Promise.all(
    items.map(async (i): Promise<FolderEntry> => {
      if (i.kind === "dir") return { name: i.name, type: "dir" };
      const st = await lstat(i.abs).catch(() => null);
      return { name: i.name, type: "file", ...(st ? { size: st.size } : {}) };
    }),
  );
  return entries.sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/** Answers one request from the shared items. Never throws; messages in answers never contain paths from this computer. */
export async function answer(items: Item[], req: unknown, search: Search, caps: FolderCaps = { edit: false, git: false }): Promise<FolderResponse | null> {
  type Loose = { id?: unknown; op?: unknown; path?: unknown; offset?: unknown; limit?: unknown; pattern?: unknown; hidden?: unknown; include?: unknown; literal?: unknown; caseSensitive?: unknown };
  const r = (req ?? {}) as Loose;
  if (typeof r?.id !== "string" || r.id.length === 0 || r.id.length > 64) return null;
  const id = r.id;
  try {
    if (items.length === 0) throw new FolderError("not_found", "Nothing is shared right now.");
    switch (r.op) {
      case "list": {
        const t = resolve(items, r.path);
        if (t === "top") return { id, ok: true, result: { path: "", entries: await topLevel(items), truncated: false } };
        if (t.single) throw new FolderError("not_a_directory", "That is a file, not a folder.");
        const res = await listDir(t.root, t.start.join("/"));
        return { id, ok: true, result: { ...res, path: under(t.prefix, res.path) } };
      }
      case "read": {
        const t = resolve(items, r.path);
        if (t === "top") throw new FolderError("not_a_file", "That is a folder. List it instead.");
        const res = await readText(t.root, t.start.join("/"), r.offset, r.limit);
        return { id, ok: true, result: { ...res, path: t.single ? t.prefix : under(t.prefix, res.path) } };
      }
      case "glob":
      case "grep": {
        const t = resolve(items, r.path);
        const targets = t === "top" ? items.map((i) => itemTarget(i, [])) : [t];
        const result =
          r.op === "glob"
            ? await search.glob(targets, r.pattern, { hidden: r.hidden, limit: r.limit })
            : await search.grep(targets, r.pattern, { include: r.include, literal: r.literal, caseSensitive: r.caseSensitive, limit: r.limit });
        return { id, ok: true, result };
      }
      case "git":
        // Read-only git (status, diff, log, show). Switched on by the host with the other AI switches.
        if (!caps.git) throw new FolderError("disabled", "The host has not allowed git in this project.");
        return { id, ok: true, result: await gitRead(items, r as never) };
      default:
        return { id, ok: false, code: "bad_request", message: "Unknown request." };
    }
  } catch (e) {
    if (e instanceof FolderError) return { id, ok: false, code: e.code, message: e.message };
    console.error("[folder] request failed:", e instanceof Error ? e.message : e);
    return { id, ok: false, code: "failed", message: "The folder couldn't be read." };
  }
}
