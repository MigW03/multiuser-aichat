import { FOLDER_LIMITS as L, type FolderEntry, type FolderErrorCode, type FolderGlobResult, type FolderListResult, type FolderMatch, type FolderReadResult, type FolderSearchResult } from "@mc/shared";
import ignore, { type Ignore } from "ignore";
import picomatch from "picomatch";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, parse, sep } from "node:path";

// Read-only access to one folder on this computer, for the project's members and the AI.
// Everything the server (and so every project member and the AI) can ask for passes through here, so the rules
// are strict: paths are relative to the folder, symlinks are never followed, secrets and junk are hidden, and
// answers are small.

export class FolderError extends Error {
  constructor(
    readonly code: FolderErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ what is hidden

/** Folders that hold secrets, other people's code or build output. Matched case-insensitively on the folder name. */
const HIDDEN_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".terraform", ".venv", "venv", "__pycache__",
  ".cache", ".next", ".nuxt", ".turbo", ".parcel-cache", "dist", "build", "target", "coverage", ".idea", "pods", ".gradle", ".yarn", ".pnpm-store",
]);

/** File names that usually hold secrets. Matched case-insensitively on the file name. */
const HIDDEN_FILES: RegExp[] = [
  /^\.env($|\.)/, // .env, .env.local, .env.production, ...
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|gpg|tfstate|tfvars)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /^\.(npmrc|netrc|pypirc|htpasswd|dockercfg|git-credentials|pgpass|my\.cnf)$/,
  /^(secrets?|credentials?)(\.|$)/,
  /^service[-_]?account.*\.json$/,
  /^\.ds_store$/,
  /^thumbs\.db$/,
];

/** Windows ignores trailing dots and spaces in names, so ".env." opens ".env". Match on the cleaned name everywhere. */
const comparable = (name: string) => name.replace(/[. ]+$/, "").toLowerCase();

export function isHiddenName(name: string, isDir: boolean): boolean {
  const n = comparable(name);
  if (n === "") return true;
  if (isDir && HIDDEN_DIRS.has(n)) return true;
  return HIDDEN_FILES.some((re) => re.test(n));
}

/** Token formats that must never reach a chat, even from a file that is shown. Best effort: the names above are the real barrier. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI, Anthropic (sk-ant-...), OpenRouter (sk-or-...)
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bsb_secret_[A-Za-z0-9_-]{16,}/g, // Supabase
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JSON web tokens (Supabase keys among them)
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted secret]");
  return out;
}

// ------------------------------------------------------------------ paths

/** Control characters, including line breaks: a name with one could pose as instructions in the AI's prompt. */
// eslint-disable-next-line no-control-regex
export const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Turns the path a requester sent into its parts, relative to the folder. "" and "." are the folder itself.
 * Absolute paths, "..", backslashes, drive letters and stream syntax (":") are refused, not repaired.
 */
export function splitPath(input: unknown): string[] {
  if (typeof input !== "string" || input.length > L.pathChars || CONTROL.test(input)) throw new FolderError("invalid_path", "That path isn't valid.");
  if (input.includes("\\") || input.includes(":") || input.startsWith("/")) throw new FolderError("invalid_path", "Use a path relative to the shared folder, like src/index.ts.");
  const parts = input.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === ".." || p.length > 255)) throw new FolderError("invalid_path", "Paths can't go up out of the shared folder.");
  return parts;
}

export type Found = { abs: string; parts: string[]; isDir: boolean; size: number; dev: number; ino: number };

/** Walks the path one name at a time with lstat. A symlink anywhere on the way ends the walk: they are never followed. */
export async function locate(root: string, input: unknown): Promise<Found> {
  const parts = splitPath(input);
  let abs = root;
  let last = { isDir: true, size: 0, dev: 0, ino: 0 };
  for (const [i, part] of parts.entries()) {
    abs = join(abs, part);
    let st;
    try {
      st = await lstat(abs);
    } catch {
      throw new FolderError("not_found", "That file or folder doesn't exist in the shared folder.");
    }
    if (st.isSymbolicLink()) throw new FolderError("excluded", "Links aren't followed, so that path can't be opened.");
    if (isHiddenName(part, st.isDirectory())) {
      throw new FolderError("excluded", "That path is hidden from the shared folder (secrets, keys, build output and similar are never shared).");
    }
    if (i < parts.length - 1 && !st.isDirectory()) throw new FolderError("not_found", "That file or folder doesn't exist in the shared folder.");
    if (!st.isDirectory() && !st.isFile()) throw new FolderError("not_a_file", "That isn't a plain file or folder.");
    last = { isDir: st.isDirectory(), size: st.size, dev: Number(st.dev), ino: Number(st.ino) };
  }
  return { abs, parts, ...last };
}

export type WriteSpot = {
  /** Absolute path of the file, which may not exist yet. */
  abs: string;
  parts: string[];
  /** Existing ancestors of the file (and the folder it lives in, if that exists): the folders that have to be created are the rest. */
  existingDepth: number;
  /** The file's current state, or null when it does not exist. */
  file: { size: number; dev: number; ino: number; mode: number } | null;
};

/**
 * Where a file would be written. Every part that exists is checked like a read (no symlinks, nothing hidden); parts
 * that do not exist yet are only allowed when their names are ordinary: no hidden names (so no .env or .git), no
 * control characters, and no trailing dot or space (Windows reads ".env." as ".env").
 */
/** Names that mean a device on Windows (writing "con.txt" opens the console). Refused on every system, so a project is the same everywhere. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

export async function locateForWrite(root: string, input: unknown): Promise<WriteSpot> {
  const parts = splitPath(input);
  if (parts.length === 0) throw new FolderError("not_a_file", "That is the shared folder itself, not a file.");
  let abs = root;
  let existingDepth = 0;
  let file: WriteSpot["file"] = null;
  for (const [i, part] of parts.entries()) {
    const isLast = i === parts.length - 1;
    abs = join(abs, part);
    if (isHiddenName(part, !isLast) || /[. ]$/.test(part) || DEVICE_NAME.test(part)) {
      throw new FolderError("excluded", "That path is hidden from the shared folder (secrets, keys, build output and similar are never shared).");
    }
    let st;
    try {
      st = await lstat(abs);
    } catch {
      // Everything from here on is new.
      if (parts.slice(i).some((p, k) => isHiddenName(p, i + k < parts.length - 1) || CONTROL.test(p) || /[. ]$/.test(p) || DEVICE_NAME.test(p))) {
        throw new FolderError("excluded", "That path is hidden from the shared folder (secrets, keys, build output and similar are never shared).");
      }
      return { abs: join(root, ...parts), parts, existingDepth, file: null };
    }
    if (st.isSymbolicLink()) throw new FolderError("excluded", "Links aren't followed, so that path can't be written.");
    if (!isLast && !st.isDirectory()) throw new FolderError("not_a_directory", "A part of that path is a file, not a folder.");
    if (isLast) {
      if (!st.isFile()) throw new FolderError("not_a_file", "That isn't a plain file.");
      file = { size: st.size, dev: Number(st.dev), ino: Number(st.ino), mode: st.mode & 0o777 };
    }
    existingDepth = i + 1;
  }
  return { abs, parts, existingDepth, file };
}

/** Checks a folder the person picked and returns its resolved location. Refuses the disk root and the home folder. */
export async function validateRoot(picked: string): Promise<string> {
  let root: string;
  try {
    root = await realpath(picked);
    if (!(await lstat(root)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new FolderError("not_a_directory", "That isn't a folder.");
  }
  const home = await realpath(homedir()).catch(() => homedir());
  const isAncestorOfHome = home === root || home.startsWith(root.endsWith(sep) ? root : root + sep);
  if (root === parse(root).root || isAncestorOfHome) {
    throw new FolderError("invalid_path", "Pick a project folder, not your home folder or a whole disk.");
  }
  return root;
}

/** The name shown to the project: the folder's own name, trimmed. */
export function folderName(root: string): string {
  const name = basename(root).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, L.nameChars);
  return name || "Shared folder";
}

// ------------------------------------------------------------------ files

const BINARY_PROBE = 8000;

/** Opens a file the walk already vetted, and checks that it is still that same plain file. */
export async function openFile(found: Found): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(found.abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new FolderError("not_found", "That file couldn't be opened.");
  }
  try {
    const st = await handle.stat();
    // A path swapped for another file between the walk and now is refused.
    if (!st.isFile() || (found.ino !== 0 && (Number(st.ino) !== found.ino || Number(st.dev) !== found.dev))) throw new FolderError("not_a_file", "That isn't a plain file.");
    return handle;
  } catch (e) {
    await handle.close().catch(() => undefined);
    throw e instanceof FolderError ? e : new FolderError("failed", "That file couldn't be read.");
  }
}

export const looksBinary = (buf: Buffer) => buf.subarray(0, BINARY_PROBE).includes(0);

export async function readWhole(handle: FileHandle, size: number, maxBytes: number): Promise<Buffer> {
  if (size > maxBytes) throw new FolderError("too_large", `That file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB, so it isn't shared.`);
  const buf = Buffer.alloc(Math.min(size, maxBytes));
  let got = 0;
  while (got < buf.length) {
    const { bytesRead } = await handle.read(buf, got, buf.length - got, got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

export async function listDir(root: string, path: unknown): Promise<FolderListResult> {
  const found = await locate(root, path);
  if (!found.isDir) throw new FolderError("not_a_directory", "That is a file, not a folder.");
  let dirents;
  try {
    dirents = await readdir(found.abs, { withFileTypes: true });
  } catch {
    throw new FolderError("failed", "That folder couldn't be read.");
  }
  const shown = dirents
    .filter((d) => (d.isFile() || d.isDirectory()) && !d.isSymbolicLink() && d.name.length <= 255 && !CONTROL.test(d.name) && !isHiddenName(d.name, d.isDirectory()))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const page = shown.slice(0, L.listEntries);
  const entries: FolderEntry[] = await Promise.all(
    page.map(async (d): Promise<FolderEntry> => {
      if (d.isDirectory()) return { name: d.name, type: "dir" };
      const st = await lstat(join(found.abs, d.name)).catch(() => null);
      return { name: d.name, type: "file", ...(st ? { size: st.size } : {}) };
    }),
  );
  return { path: found.parts.join("/"), entries, truncated: shown.length > page.length };
}

const clampInt = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback);

export async function readText(root: string, path: unknown, offset?: unknown, limit?: unknown): Promise<FolderReadResult> {
  const found = await locate(root, path);
  if (found.isDir) throw new FolderError("not_a_file", "That is a folder. List it instead.");
  const handle = await openFile(found);
  let buf: Buffer;
  try {
    buf = await readWhole(handle, (await handle.stat()).size, L.fileBytes);
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (looksBinary(buf)) throw new FolderError("binary", "That looks like a binary file, so it isn't shared.");

  const lines = redactSecrets(buf.toString("utf8")).split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") lines.pop();
  const start = clampInt(offset, 1, Math.max(1, lines.length), 1);
  const max = clampInt(limit, 1, L.readLines, L.readLines);
  const out: string[] = [];
  let bytes = 0;
  let i = start - 1;
  for (; i < lines.length && out.length < max; i++) {
    const line = lines[i]!.length > L.lineChars ? `${lines[i]!.slice(0, L.lineChars)}… [line cut]` : lines[i]!;
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > L.readBytes && out.length > 0) break;
    out.push(line);
  }
  return { path: found.parts.join("/"), text: out.join("\n"), startLine: start, endLine: start - 1 + out.length, totalLines: lines.length, truncated: i < lines.length };
}

// ------------------------------------------------------------------ search: glob and grep, as opencode's tools
// Like opencode (which runs ripgrep), searches skip files listed in .gitignore and hidden (dot) files unless asked,
// on top of the secrets and junk that are never shared. Reading a path directly ignores .gitignore, as opencode's read does.

/** Where a search runs: inside `root`, starting at `start` (a folder or one file). Results are reported under `prefix`. */
export type Target = { root: string; start: string[]; prefix: string; single?: boolean };

type Hit = { abs: string; rel: string; fromStart: string; size: number; mtimeMs: number; dev: number; ino: number };
type Walk = { hidden: boolean; deadline: number; scanned: number; cut: boolean };

const GITIGNORE_BYTES = 256 * 1024;

async function loadIgnore(dirAbs: string): Promise<Ignore | null> {
  try {
    const st = await lstat(join(dirAbs, ".gitignore"));
    if (!st.isFile() || st.size > GITIGNORE_BYTES) return null;
    return ignore().add(await readFile(join(dirAbs, ".gitignore"), "utf8"));
  } catch {
    return null;
  }
}

type Rule = { base: string[]; ig: Ignore };
const ignoredBy = (rules: Rule[], parts: string[], isDir: boolean) =>
  rules.some((r) => {
    const rel = parts.slice(r.base.length).join("/");
    return rel !== "" && r.ig.ignores(isDir ? `${rel}/` : rel);
  });

/** Every shareable file under a target, in name order, minus hidden, ignored and linked entries. Stops at the walk's limits. */
async function* walk(t: Target, w: Walk): AsyncGenerator<Hit> {
  const start = await locate(t.root, t.start.join("/"));
  const report = (rel: string) => (t.single ? t.prefix : [t.prefix, rel].filter(Boolean).join("/"));
  if (!start.isDir) {
    w.scanned++;
    yield { abs: start.abs, rel: report(start.parts.join("/")), fromStart: basename(start.abs), size: start.size, mtimeMs: 0, dev: start.dev, ino: start.ino };
    return;
  }
  // .gitignore files from the folder's top down to where the search starts all apply.
  const rules: Rule[] = [];
  for (let i = 0; i <= start.parts.length; i++) {
    const ig = await loadIgnore(join(t.root, ...start.parts.slice(0, i)));
    if (ig) rules.push({ base: start.parts.slice(0, i), ig });
  }

  async function* dir(abs: string, parts: string[], rules: Rule[]): AsyncGenerator<Hit> {
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      if (w.scanned >= L.searchFiles || Date.now() > w.deadline) {
        w.cut = true;
        return;
      }
      if (d.isSymbolicLink() || (!d.isFile() && !d.isDirectory()) || d.name.length > 255 || CONTROL.test(d.name)) continue;
      if (isHiddenName(d.name, d.isDirectory()) || (!w.hidden && d.name.startsWith("."))) continue;
      const childParts = [...parts, d.name];
      if (ignoredBy(rules, childParts, d.isDirectory())) continue;
      const childAbs = join(abs, d.name);
      if (d.isDirectory()) {
        const ig = await loadIgnore(childAbs);
        yield* dir(childAbs, childParts, ig ? [...rules, { base: childParts, ig }] : rules);
      } else {
        const st = await lstat(childAbs).catch(() => null);
        if (!st?.isFile()) continue;
        w.scanned++;
        const rel = childParts.join("/");
        yield { abs: childAbs, rel: report(rel), fromStart: childParts.slice(start.parts.length).join("/"), size: st.size, mtimeMs: st.mtimeMs, dev: Number(st.dev), ino: Number(st.ino) };
      }
    }
  }
  yield* dir(start.abs, start.parts, rules);
}

function checkPattern(pattern: unknown, what: string): string {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > L.patternChars || CONTROL.test(pattern)) {
    throw new FolderError("bad_request", `The ${what} must be 1 to ${L.patternChars} characters on one line.`);
  }
  return pattern;
}

/** A glob like ripgrep's: a pattern without a slash matches the file name at any depth. */
function globMatcher(pattern: string, dot: boolean): (path: string) => boolean {
  try {
    return picomatch(pattern, { dot, basename: !pattern.includes("/"), maxLength: L.patternChars });
  } catch {
    throw new FolderError("bad_request", "That glob pattern isn't valid.");
  }
}

const limitOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(L.searchLimit, Math.max(1, Math.floor(v))) : L.searchLimit);

/** opencode's glob: file paths matching a pattern, newest first. */
export async function globFiles(targets: Target[], pattern: unknown, opts: { hidden?: unknown; limit?: unknown } = {}): Promise<FolderGlobResult> {
  const match = globMatcher(checkPattern(pattern, "glob pattern"), opts.hidden === true);
  const w: Walk = { hidden: opts.hidden === true, deadline: Date.now() + L.searchMs, scanned: 0, cut: false };
  const hits: Hit[] = [];
  for (const t of targets) {
    for await (const h of walk(t, w)) if (match(h.fromStart)) hits.push(h);
    if (w.cut) break;
  }
  hits.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.rel < b.rel ? -1 : 1));
  const limit = limitOf(opts.limit);
  return { paths: hits.slice(0, limit).map((h) => h.rel), truncated: w.cut || hits.length > limit };
}

/**
 * opencode's grep: lines matching a regular expression (or plain text), grouped by file. A regular expression from the
 * AI could take forever on some input, so the app runs this in a worker thread it can stop (folder-worker.ts).
 */
export async function grepFiles(
  targets: Target[],
  pattern: unknown,
  opts: { include?: unknown; literal?: unknown; caseSensitive?: unknown; limit?: unknown } = {},
): Promise<FolderSearchResult> {
  const text = checkPattern(pattern, "search pattern");
  const caseSensitive = opts.caseSensitive !== false;
  let test: (line: string) => boolean;
  if (opts.literal === true) {
    const needle = caseSensitive ? text : text.toLowerCase();
    test = (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
  } else {
    let re: RegExp;
    try {
      re = new RegExp(text, caseSensitive ? "" : "i");
    } catch {
      throw new FolderError("bad_request", "That regular expression isn't valid. Set literal to search for the text as written.");
    }
    test = (line) => re.test(line);
  }
  const include = opts.include === undefined || opts.include === "" ? null : globMatcher(checkPattern(opts.include, "include pattern"), true);
  const limit = limitOf(opts.limit);
  const w: Walk = { hidden: false, deadline: Date.now() + L.searchMs, scanned: 0, cut: false };
  const matches: FolderMatch[] = [];

  outer: for (const t of targets) {
    for await (const h of walk(t, w)) {
      if (include && !include(basename(h.fromStart)) && !include(h.fromStart)) continue;
      if (h.size > L.searchFileBytes) continue;
      let handle: FileHandle;
      try {
        handle = await openFile({ abs: h.abs, parts: [], isDir: false, size: h.size, dev: h.dev, ino: h.ino });
      } catch {
        continue;
      }
      let buf: Buffer | null;
      try {
        buf = await readWhole(handle, (await handle.stat()).size, L.searchFileBytes).catch(() => null);
      } finally {
        await handle.close().catch(() => undefined);
      }
      if (!buf || looksBinary(buf)) continue;
      const lines = redactSecrets(buf.toString("utf8")).split(/\r\n|\n|\r/);
      for (const [n, line] of lines.entries()) {
        if (!test(line.length > L.lineChars ? line.slice(0, L.lineChars) : line)) continue;
        if (matches.length === limit) {
          w.cut = true;
          break outer;
        }
        matches.push({ path: h.rel, line: n + 1, text: line.trim().slice(0, L.searchLineChars) });
      }
    }
    if (w.cut) break;
  }
  return { matches, truncated: w.cut };
}
