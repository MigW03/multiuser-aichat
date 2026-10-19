import { FOLDER_LIMITS as L, type ChangePreview } from "@mc/shared";
import { structuredPatch } from "diff";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { replaceText } from "./edit-match.ts";
import { FolderError, locateForWrite, looksBinary, openFile, readWhole, redactSecrets } from "./folder-fs.ts";
import { resolve, under, type Item } from "./folder-items.ts";

// What the AI proposes to change in the shared files. Two steps, kept apart on purpose:
//  1. stageChange(): reads the file, works out the new text and a diff, and writes NOTHING.
//  2. commitStaged(): runs only after the host approved the diff in this app. It checks the file is still exactly what
//     the diff was made from (same file, same SHA-256), then replaces it in one step.
// Paths follow the same rules as reads: relative to the shared folder, no symlinks, nothing hidden (.env, keys, .git...).

export type Staged = {
  id: string;
  kind: "edit" | "write";
  root: string;
  parts: string[];
  abs: string;
  created: boolean;
  /** SHA-256 of the file as the diff was made. null for a new file. */
  baseSha: string | null;
  dev: number;
  ino: number;
  mode: number;
  next: string;
  change: ChangePreview;
};

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Throws when text holds something shaped like a key or token: the host must not be asked to approve a secret, and a mask must never be written into a file. */
const noSecrets = (text: string, what: string) => {
  if (redactSecrets(text) !== text) throw new FolderError("secrets", `${what} contains something that looks like a secret (a key, token or password), so the AI cannot change it. Make this change by hand.`);
};

const DIFF_MS = 1500;

function diffOf(path: string, before: string, after: string): Pick<ChangePreview, "diff" | "added" | "removed" | "cut"> {
  // A diff of two big, very different files can take very long, and this runs in the app's main process. Past the
  // time limit the change is shown as a whole-file replacement instead.
  const patch =
    structuredPatch(path, path, before, after, "", "", { context: 3, timeout: DIFF_MS }) ??
    (() => {
      const oldLines = before === "" ? [] : before.replace(/\n$/, "").split("\n");
      const newLines = after === "" ? [] : after.replace(/\n$/, "").split("\n");
      return { hunks: [{ oldStart: 1, oldLines: oldLines.length, newStart: 1, newLines: newLines.length, lines: [...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)] }] };
    })();
  let added = 0;
  let removed = 0;
  const out: string[] = [];
  for (const h of patch.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const line of h.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
      out.push(line);
    }
  }
  const full = out.join("\n");
  const cut = full.length > L.diffChars;
  return { diff: cut ? `${full.slice(0, L.diffChars)}\n… [diff cut]` : full, added, removed, cut };
}

type Loose = { id?: unknown; op?: unknown; path?: unknown; oldString?: unknown; newString?: unknown; replaceAll?: unknown; content?: unknown; hadRead?: unknown };

/** Works out a proposed change without touching the disk. Throws a FolderError whose message the AI and the chat can see. */
export async function stageChange(items: Item[], req: Loose): Promise<Staged> {
  const id = req.id as string;
  const kind = req.op === "write" ? "write" : "edit";
  const t = resolve(items, req.path);
  if (t === "top") throw new FolderError("not_a_file", "Name a file inside the shared folder.");
  const spot = await locateForWrite(t.root, t.start.join("/"));
  const shown = t.single ? t.prefix : under(t.prefix, spot.parts.join("/"));

  let before = "";
  let baseSha: string | null = null;
  // As in opencode, a file that exists is not overwritten by a model that has not looked at it.
  if (spot.file && kind === "write" && req.hadRead !== true) {
    throw new FolderError("exists", "That file already exists. Read it first, then use edit for a small change or write to replace it.");
  }
  if (spot.file) {
    const handle = await openFile({ abs: spot.abs, parts: spot.parts, isDir: false, size: spot.file.size, dev: spot.file.dev, ino: spot.file.ino });
    let buf: Buffer;
    try {
      buf = await readWhole(handle, (await handle.stat()).size, L.fileBytes);
    } finally {
      await handle.close().catch(() => undefined);
    }
    before = buf.toString("utf8");
    if (looksBinary(buf) || Buffer.from(before, "utf8").compare(buf) !== 0) throw new FolderError("binary", "That file is not plain UTF-8 text, so the AI cannot change it.");
    noSecrets(before, "That file");
    baseSha = sha256(buf);
  } else if (kind === "edit") {
    throw new FolderError("not_found", "That file doesn't exist. To create a file, use write.");
  }

  let next: string;
  if (kind === "edit") {
    if (typeof req.oldString !== "string" || typeof req.newString !== "string" || req.oldString.length > L.editChars || req.newString.length > L.editChars) {
      throw new FolderError("bad_request", `oldString and newString must be text of at most ${L.editChars} characters.`);
    }
    noSecrets(req.newString, "The new text");
    next = replaceText(before, req.oldString, req.newString, req.replaceAll === true);
  } else {
    if (typeof req.content !== "string" || req.content.length > L.writeChars) throw new FolderError("bad_request", `content must be text of at most ${L.writeChars} characters.`);
    noSecrets(req.content, "The new content");
    next = req.content;
  }
  const bytes = Buffer.from(next, "utf8");
  if (bytes.length > L.fileBytes) throw new FolderError("too_large", `The result would be larger than ${Math.round(L.fileBytes / 1024 / 1024)} MB.`);
  if (looksBinary(bytes)) throw new FolderError("bad_request", "The new text contains a null character, so it is not plain text.");
  if (next === before && spot.file) throw new FolderError("bad_request", "That change leaves the file exactly as it is.");

  return {
    id,
    kind,
    root: t.root,
    parts: spot.parts,
    abs: spot.abs,
    created: !spot.file,
    baseSha,
    dev: spot.file?.dev ?? 0,
    ino: spot.file?.ino ?? 0,
    mode: spot.file?.mode ?? 0o644,
    next,
    change: { id, kind, path: shown, created: !spot.file, ...diffOf(shown, before, next) },
  };
}

/** Writes an approved change. Refuses (code `stale`) when the file is no longer what the host looked at. */
export async function commitStaged(s: Staged): Promise<void> {
  // Look again: the path may have changed since the diff was made (a link put in place, a folder replaced).
  const spot = await locateForWrite(s.root, s.parts.join("/"));
  const bytes = Buffer.from(s.next, "utf8");

  if (s.created) {
    if (spot.file) throw new FolderError("stale", "A file appeared at that path after the diff was made. Ask the AI to try again.");
    for (let i = spot.existingDepth; i < s.parts.length - 1; i++) {
      const dir = join(s.root, ...s.parts.slice(0, i + 1));
      try {
        await mkdir(dir);
      } catch (e) {
        // Someone made it in the meantime: fine if it is a real folder.
        const st = await lstat(dir).catch(() => null);
        if (!st?.isDirectory() || st.isSymbolicLink()) throw new FolderError("failed", "A folder for that file couldn't be created.");
        void e;
      }
    }
    let handle;
    try {
      handle = await open(s.abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
    } catch {
      throw new FolderError("stale", "A file appeared at that path after the diff was made. Ask the AI to try again.");
    }
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch {
      await handle.close().catch(() => undefined);
      await unlink(s.abs).catch(() => undefined);
      throw new FolderError("failed", "The file couldn't be written.");
    }
    await handle.close();
    return;
  }

  if (!spot.file || spot.file.ino !== s.ino || spot.file.dev !== s.dev) throw new FolderError("stale", "The file was replaced after the diff was made. Ask the AI to try again.");
  const current = await openFile({ abs: s.abs, parts: s.parts, isDir: false, size: spot.file.size, dev: spot.file.dev, ino: spot.file.ino });
  try {
    const buf = await readWhole(current, (await current.stat()).size, L.fileBytes);
    if (sha256(buf) !== s.baseSha) throw new FolderError("stale", "The file changed after the diff was made. Ask the AI to try again.");
  } finally {
    await current.close().catch(() => undefined);
  }
  if ((s.mode & 0o200) === 0) throw new FolderError("failed", "The file is read-only, so it was not changed.");
  await access(dirname(s.abs), constants.W_OK).catch(() => {
    throw new FolderError("failed", "The folder is read-only, so the file was not changed.");
  });

  // Write next to the file and swap it in, so a crash never leaves half a file.
  const tmp = join(dirname(s.abs), `.${basename(s.abs)}.${randomBytes(6).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), s.mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(tmp, s.mode);
    await rename(tmp, s.abs);
  } catch (e) {
    await handle?.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw e instanceof FolderError ? e : new FolderError("failed", "The file couldn't be written.");
  }
}
