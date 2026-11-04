import { isAbsolute, relative, resolve, sep } from "node:path";

// "Erase Nido data on this computer": everything the app keeps in its own data folder (the signed-in session, the list of
// shared folders and files, connected tool servers and their settings, custom panels with their saved notes, cache). A Mac
// app can't run code when it is dragged to the Trash, so the app offers this itself.

/**
 * Whether `userData` is a folder this app may delete: an absolute path strictly inside the operating system's application-data
 * folder. Never the application-data folder itself, never anything above it, never a path that only looks like it is inside.
 */
export function safeToErase(userData: string, appData: string): boolean {
  if (typeof userData !== "string" || typeof appData !== "string" || !isAbsolute(userData) || !isAbsolute(appData)) return false;
  const target = resolve(userData);
  const base = resolve(appData);
  if (target === base || base.length < 4) return false;
  const rel = relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes(`..${sep}`) && target.startsWith(base + sep);
}

/** What the confirmation window says, in plain words. */
export const ERASE_MESSAGE = "Erase all Nido data on this computer?";
export const ERASE_DETAIL = [
  "This signs you out and deletes, from this computer only:",
  "- your sign-in",
  "- the list of folders and files you share (the files themselves are not touched)",
  "- your connected tool servers and their settings",
  "- your custom panels and what they saved (ticks, notes)",
  "- the app's cache",
  "",
  "Nothing on the server or in your shared folders changes. Nido quits when it is done. This cannot be undone.",
].join("\n");

/** The confirmation counts for this long; after that the page has to ask the person again. */
export const ERASE_APPROVAL_MS = 60_000;
