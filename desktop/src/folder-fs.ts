import { FOLDER_LIMITS as L, type FolderEntry, type FolderErrorCode, type FolderListResult, type FolderMatch, type FolderReadResult, type FolderSearchResult } from "@mc/shared";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
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
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

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

type Found = { abs: string; parts: string[]; isDir: boolean; size: number; dev: number; ino: number };

/** Walks the path one name at a time with lstat. A symlink anywhere on the way ends the walk: they are never followed. */
async function locate(root: string, input: unknown): Promise<Found> {
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
async function openFile(found: Found): Promise<FileHandle> {
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

const looksBinary = (buf: Buffer) => buf.subarray(0, BINARY_PROBE).includes(0);

async function readWhole(handle: FileHandle, size: number, maxBytes: number): Promise<Buffer> {
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

// ------------------------------------------------------------------ search

/** `*` and `?` only, matched against the file name. Anything else in the pattern is refused so it can never be a regex. */
function globToRegex(glob: string): RegExp {
  if (!/^[A-Za-z0-9._*?-]{1,60}$/.test(glob)) throw new FolderError("bad_request", "The file pattern may only use letters, digits, . _ - and the wildcards * and ?.");
  return new RegExp(`^${glob.replace(/[.]/g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
}

/** Finds a piece of text in the files under `path`. Plain text, not a regular expression, so a search can't hang the app. */
export async function searchText(root: string, query: unknown, path?: unknown, glob?: unknown): Promise<FolderSearchResult> {
  if (typeof query !== "string" || query.trim().length === 0 || query.length > L.searchQueryChars || CONTROL.test(query)) {
    throw new FolderError("bad_request", `Search for 1 to ${L.searchQueryChars} characters of plain text.`);
  }
  const needle = query.toLowerCase();
  const nameFilter = typeof glob === "string" && glob !== "" ? globToRegex(glob) : null;
  const start = await locate(root, path ?? "");
  const deadline = Date.now() + L.searchMs;
  const matches: FolderMatch[] = [];
  let scanned = 0;
  let truncated = false;

  const full = () => matches.length >= L.searchMatches || scanned >= L.searchFiles || Date.now() > deadline;

  async function scanFile(abs: string, parts: string[], size: number, dev: number, ino: number) {
    if (size > L.searchFileBytes) return;
    scanned++;
    let handle: FileHandle;
    try {
      handle = await openFile({ abs, parts, isDir: false, size, dev, ino });
    } catch {
      return;
    }
    try {
      const buf = await readWhole(handle, (await handle.stat()).size, L.searchFileBytes).catch(() => null);
      if (!buf || looksBinary(buf)) return;
      const lines = redactSecrets(buf.toString("utf8")).split(/\r\n|\n|\r/);
      for (const [n, line] of lines.entries()) {
        if (!line.toLowerCase().includes(needle)) continue;
        matches.push({ path: parts.join("/"), line: n + 1, text: line.trim().slice(0, L.searchLineChars) });
        if (matches.length >= L.searchMatches) return;
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async function walk(abs: string, parts: string[]) {
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      if (full()) {
        truncated = true;
        return;
      }
      if (d.isSymbolicLink() || (!d.isFile() && !d.isDirectory()) || d.name.length > 255 || CONTROL.test(d.name) || isHiddenName(d.name, d.isDirectory())) continue;
      const childAbs = join(abs, d.name);
      const childParts = [...parts, d.name];
      if (d.isDirectory()) {
        await walk(childAbs, childParts);
      } else if (!nameFilter || nameFilter.test(d.name)) {
        const st = await lstat(childAbs).catch(() => null);
        if (st?.isFile()) await scanFile(childAbs, childParts, st.size, Number(st.dev), Number(st.ino));
      }
    }
  }

  if (start.isDir) await walk(start.abs, start.parts);
  else if (!nameFilter || nameFilter.test(basename(start.abs))) await scanFile(start.abs, start.parts, start.size, start.dev, start.ino);
  if (full() && matches.length >= L.searchMatches) truncated = true;
  return { matches, truncated };
}
