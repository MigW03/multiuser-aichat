import { FOLDER_LIMITS, FILE_STORE_LIMITS, isHiddenName } from "@mc/shared";

// Where a project's stored files live in the bucket, and which paths may be stored. Every path comes from a client, so it is
// checked here and refused, never repaired. The key is always projects/<project>/<share>/<path inside the share>, with both
// ids checked as UUIDs, so one project's files can't be reached with another project's or item's name.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u{0}-\u{1f}\u{7f}-\u{9f}\u{2028}\u{2029}]/u;
/** Zero-width and direction-changing characters: they make one name look like another. */
const INVISIBLE = /[\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2069}\u{feff}]/u;
/** Names that mean a device on Windows. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

export class PathError extends Error {}

/** The parts of a path inside a shared item. "" is the item's top level (only allowed where `allowRoot` is set). */
export function splitStoredPath(input: unknown, opts: { allowRoot?: boolean; isDir?: boolean } = {}): string[] {
  if (typeof input !== "string" || input.length > FOLDER_LIMITS.pathChars || CONTROL.test(input) || INVISIBLE.test(input)) throw new PathError("That path isn't valid.");
  if (input === "") {
    if (opts.allowRoot) return [];
    throw new PathError("That path isn't valid.");
  }
  if (input.includes("\\") || input.includes(":") || input.startsWith("/") || input.endsWith("/")) throw new PathError("Use a path relative to the shared item, like src/index.ts.");
  const parts = input.split("/");
  if (parts.length > FILE_STORE_LIMITS.depth) throw new PathError("That path is nested too deeply.");
  parts.forEach((p, i) => {
    if (p === "" || p === "." || p === ".." || p.length > 255 || /[. ]$/.test(p) || DEVICE_NAME.test(p)) throw new PathError("That path isn't valid.");
    // Anything the desktop app would not share is not stored either, whatever the sender claims.
    if (isHiddenName(p, i < parts.length - 1 || Boolean(opts.isDir))) throw new PathError("That path is hidden (secrets, keys, build output and similar are never stored).");
  });
  return parts;
}

export function projectPrefix(projectId: string): string {
  if (!UUID.test(projectId)) throw new PathError("Invalid project");
  return `projects/${projectId.toLowerCase()}/`;
}

export function sharePrefix(projectId: string, shareId: string): string {
  if (!UUID.test(shareId)) throw new PathError("Invalid item");
  return `${projectPrefix(projectId)}${shareId.toLowerCase()}/`;
}

export function objectKey(projectId: string, shareId: string, parts: string[]): string {
  if (parts.length === 0) throw new PathError("That path isn't valid.");
  return `${sharePrefix(projectId, shareId)}${parts.join("/")}`;
}

/** The key's path inside its share, for listings. */
export function relativeTo(prefix: string, key: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/** A name for the saved file: only the last part of the path, with nothing that could break a header. */
export function downloadName(parts: string[]): string {
  // eslint-disable-next-line no-control-regex
  return (parts[parts.length - 1] ?? "file").replace(/[\u0000-\u001f\u007f"\\/]/g, "_");
}
