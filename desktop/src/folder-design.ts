import { DESIGN_LIMITS, FOLDER_LIMITS as L, isDesignPath, type FolderDesignResult } from "@mc/shared";
import { FolderError, locateForWrite, looksBinary, openFile, readWhole } from "./folder-fs.ts";
import { resolve, under, type Item } from "./folder-items.ts";

// Design files (`*.design.html`) in the shared items, from before designs belonged to the project. They are only read
// here, whole (a normal read stops at 50 KB), so the canvas can show one and copy it into the project. Nothing is written:
// the host's files change only through approved edits. Only paths ending in .design.html, inside an approved item, under
// the same path rules as every read (no links, nothing hidden), and plain UTF-8 text.

type Loose = { path?: unknown };

/** Where a design file lives, after the path checks every file access gets. */
async function spotOf(items: Item[], path: unknown) {
  if (!isDesignPath(path)) throw new FolderError("bad_request", "Only design files (ending in .design.html) can be read this way.");
  const t = resolve(items, path);
  if (t === "top") throw new FolderError("not_a_file", "Name a file inside the shared folder.");
  const spot = await locateForWrite(t.root, t.start.join("/"));
  const shown = t.single ? t.prefix : under(t.prefix, spot.parts.join("/"));
  return { spot, shown };
}

/** The file's text, or null when there is no file. */
async function current(spot: Awaited<ReturnType<typeof locateForWrite>>): Promise<string | null> {
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
  return text;
}

/** Reads a whole design file (up to the design size limit). */
export async function designRead(items: Item[], req: Loose): Promise<FolderDesignResult> {
  const { spot, shown } = await spotOf(items, req.path);
  const text = await current(spot);
  if (text === null) throw new FolderError("not_found", "That design doesn't exist.");
  if (text.length > DESIGN_LIMITS.chars) throw new FolderError("too_large", `That design is larger than ${DESIGN_LIMITS.chars} characters.`);
  return { path: shown, text };
}
