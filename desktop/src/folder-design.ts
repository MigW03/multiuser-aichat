import { DESIGN_LIMITS, designUnsafe, FOLDER_LIMITS as L, isDesignPath, type DesignReadResult, type DesignWriteResult } from "@mc/shared";
import { createHash } from "node:crypto";
import { replaceText } from "./edit-match.ts";
import { commitStaged } from "./folder-changes.ts";
import { FolderError, locateForWrite, looksBinary, openFile, readWhole, redactSecrets } from "./folder-fs.ts";
import { resolve, under, type Item } from "./folder-items.ts";

// Design files (`*.design.html`) in the shared items. Unlike other files, any member of the project may save one from the
// canvas, and the AI may write one, without the host approving each change: the host agreed to that for design files only
// (2026-10-23). What keeps that safe:
//  - only paths ending in .design.html, inside an approved item, under the same path rules as every write (no links, nothing
//    hidden, no device names) and the same text rules (plain UTF-8, no secrets);
//  - the text must not hold scripts or anything else active (designUnsafe), so a design file stays inert even in a browser;
//  - a save names the version it was made from (`baseSha`), and a file that changed since is not overwritten (`stale`).

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** One design save at a time in this app, so two saves never read the same version and both write. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

type Loose = { path?: unknown; content?: unknown; baseSha?: unknown; hadRead?: unknown; oldString?: unknown; newString?: unknown; replaceAll?: unknown };

/** Where a design file lives, after the checks every write gets. */
async function spotOf(items: Item[], path: unknown) {
  if (!isDesignPath(path)) throw new FolderError("bad_request", "Only design files (ending in .design.html) can be saved this way.");
  const t = resolve(items, path);
  if (t === "top") throw new FolderError("not_a_file", "Name a file inside the shared folder.");
  const spot = await locateForWrite(t.root, t.start.join("/"));
  const shown = t.single ? t.prefix : under(t.prefix, spot.parts.join("/"));
  return { t, spot, shown };
}

/** The file's text and hash, or null when there is no file yet. */
async function current(spot: Awaited<ReturnType<typeof locateForWrite>>): Promise<{ text: string; sha: string } | null> {
  if (!spot.file) return null;
  const handle = await openFile({ abs: spot.abs, parts: spot.parts, isDir: false, size: spot.file.size, dev: spot.file.dev, ino: spot.file.ino });
  let buf: Buffer;
  try {
    buf = await readWhole(handle, (await handle.stat()).size, L.fileBytes);
  } finally {
    await handle.close().catch(() => undefined);
  }
  const text = buf.toString("utf8");
  if (looksBinary(buf) || Buffer.from(text, "utf8").compare(buf) !== 0) throw new FolderError("binary", "That design file is not plain UTF-8 text.");
  return { text, sha: sha256(buf) };
}

function checkText(text: string) {
  if (text.length > DESIGN_LIMITS.chars) throw new FolderError("too_large", `A design can be at most ${DESIGN_LIMITS.chars} characters.`);
  if (text.includes("\u0000")) throw new FolderError("bad_request", "The design contains a null character, so it is not plain text.");
  if (redactSecrets(text) !== text) throw new FolderError("secrets", "The design contains something that looks like a secret (a key, token or password), so it was not saved.");
  const unsafe = designUnsafe(text);
  if (unsafe) throw new FolderError("bad_request", `Design files cannot contain ${unsafe}. Use plain HTML elements with inline styles only.`);
}

/** Reads a whole design file (up to the design size limit), with its hash for the next save. */
export async function designRead(items: Item[], req: Loose): Promise<DesignReadResult> {
  const { spot, shown } = await spotOf(items, req.path);
  const now = await current(spot);
  if (!now) throw new FolderError("not_found", "That design doesn't exist.");
  if (now.text.length > DESIGN_LIMITS.chars) throw new FolderError("too_large", `That design is larger than ${DESIGN_LIMITS.chars} characters.`);
  return { path: shown, text: now.text, sha: now.sha };
}

async function save(spot: Awaited<ReturnType<typeof locateForWrite>>, t: Exclude<ReturnType<typeof resolve>, "top">, shown: string, before: { text: string; sha: string } | null, next: string): Promise<DesignWriteResult> {
  checkText(next);
  const bytes = Buffer.from(next, "utf8");
  if (before && before.text === next) return { path: shown, sha: before.sha, created: false };
  await commitStaged({
    id: "design",
    kind: "write",
    root: t.root,
    parts: spot.parts,
    abs: spot.abs,
    created: !before,
    baseSha: before?.sha ?? null,
    dev: spot.file?.dev ?? 0,
    ino: spot.file?.ino ?? 0,
    mode: spot.file?.mode ?? 0o644,
    next,
    change: { id: "design", kind: "write", path: shown, created: !before, added: 0, removed: 0, diff: "", cut: false },
  });
  return { path: shown, sha: sha256(bytes), created: !before };
}

/**
 * Saves a whole design. `baseSha` is the version the text was made from: null to create a new file (refused when one
 * exists), a hash to replace exactly that version (refused as `stale` when the file changed). Without it (the AI's write)
 * an existing file is only replaced when the AI has read it (`hadRead`).
 */
export function designWrite(items: Item[], req: Loose): Promise<DesignWriteResult> {
  return serial(() => writeNow(items, req));
}

async function writeNow(items: Item[], req: Loose): Promise<DesignWriteResult> {
  if (typeof req.content !== "string") throw new FolderError("bad_request", "content must be text.");
  const { t, spot, shown } = await spotOf(items, req.path);
  const before = await current(spot);
  if (req.baseSha === null && before) throw new FolderError("exists", "A design with that name already exists.");
  if (typeof req.baseSha === "string" && (!before || before.sha !== req.baseSha)) throw new FolderError("stale", "The design changed since it was opened. It was reloaded.");
  if (req.baseSha === undefined && before && req.hadRead !== true) throw new FolderError("exists", "That design already exists. Read it first, then use design_edit for a small change or design_write to replace it.");
  return save(spot, t, shown, before, req.content);
}

/** Replaces text in a design file, like the AI's edit tool, and saves it at once. */
export function designEdit(items: Item[], req: Loose): Promise<DesignWriteResult> {
  return serial(() => editNow(items, req));
}

async function editNow(items: Item[], req: Loose): Promise<DesignWriteResult> {
  if (typeof req.oldString !== "string" || typeof req.newString !== "string" || req.oldString.length > L.editChars || req.newString.length > L.editChars) {
    throw new FolderError("bad_request", `oldString and newString must be text of at most ${L.editChars} characters.`);
  }
  const { t, spot, shown } = await spotOf(items, req.path);
  const before = await current(spot);
  if (!before) throw new FolderError("not_found", "That design doesn't exist. To create one, use design_write.");
  return save(spot, t, shown, before, replaceText(before.text, req.oldString, req.newString, req.replaceAll === true));
}
