// multiuserchat:// links bring people back into the app from the browser: the links in confirmation and
// password-reset emails (auth) and shared chat links (open).
export const SCHEME = "multiuserchat";

// Only what Supabase puts in the fragment of a redirect, nothing else is passed on to the page.
const AUTH_KEYS = new Set([
  "access_token", "refresh_token", "expires_in", "expires_at", "token_type", "type", "sb",
  "error", "error_code", "error_description",
]);
const AUTH_TYPES = new Set(["signup", "recovery", "invite", "magiclink", "email_change", "email"]);
const ROUTE_HASH = /^#\/[A-Za-z0-9/_-]{0,200}$/;
const MAX_LINK = 4096; // a Supabase JWT-bearing link is about 1 KB

export type DeepLink = { hash: string; reload: boolean };

/** Turns a multiuserchat:// link into the hash the app should open with, or null if it is not one of ours. */
export function parseDeepLink(raw: string): DeepLink | null {
  if (raw.length > MAX_LINK) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${SCHEME}:`) return null;
  if (url.hostname === "open") return ROUTE_HASH.test(url.hash) ? { hash: url.hash, reload: false } : null;
  if (url.hostname !== "auth") return null;
  const params = new URLSearchParams(url.hash.replace(/^#/, ""));
  const kept = new URLSearchParams();
  for (const [key, value] of params) if (AUTH_KEYS.has(key) && value.length <= 2048) kept.set(key, value);
  const type = kept.get("type");
  if (type && !AUTH_TYPES.has(type)) return null;
  if (!kept.has("access_token") && !kept.has("error")) return null;
  // A signed-in link must carry the refresh token too, or Supabase ignores it.
  if (kept.has("access_token") && !kept.has("refresh_token")) return null;
  return { hash: `#${kept.toString()}`, reload: true };
}
