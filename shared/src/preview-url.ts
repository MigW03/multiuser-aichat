// Which addresses the app's preview may open: a web page served from this very computer, nothing else. The page checks
// an address with this before it asks the desktop app to open it, and the app checks it again on its own.

const HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_LENGTH = 2048;

/** Ports of common dev servers. The empty state offers the ones found running. */
export const PREVIEW_PORTS = [3000, 3001, 4173, 4200, 5173, 5174, 8000, 8080] as const;

/**
 * The full address to open for what a person typed, or null when it is not a localhost address. "5173" and
 * "localhost:5173" become http://localhost:5173/. Only http and https, only localhost, 127.0.0.1 and [::1], any port,
 * no user name or password in the address.
 */
export function parsePreviewUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text || text.length > MAX_LENGTH || /\s/.test(text)) return null;
  const full = /^\d{1,5}$/.test(text) ? `http://localhost:${text}` : text.includes("://") ? text : `http://${text}`;
  let url: URL;
  try {
    url = new URL(full);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!HOSTS.has(url.hostname)) return null;
  return url.href;
}

/** The port an address connects to. */
export function previewPort(url: string): number | null {
  const parsed = parsePreviewUrl(url);
  if (!parsed) return null;
  const u = new URL(parsed);
  return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
}

/** The short form shown in the address bar and on buttons: no scheme for plain http, no trailing slash on the bare address. */
export function previewLabel(url: string): string {
  try {
    const u = new URL(url);
    const rest = `${u.pathname}${u.search}${u.hash}`;
    return `${u.protocol === "https:" ? "https://" : ""}${u.host}${rest === "/" ? "" : rest}`;
  } catch {
    return url;
  }
}

/** Localhost addresses written out in a text (an AI answer, for example), in order, without repeats. */
export function findPreviewUrls(text: string, max = 3): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?![\w@-]|\.\w)(?:[/?#][^\s<>"')\]]*)?/gi)) {
    const url = parsePreviewUrl(m[0].replace(/[.,;:!?]+$/, ""));
    if (url && !found.includes(url)) found.push(url);
    if (found.length >= max) break;
  }
  return found;
}
