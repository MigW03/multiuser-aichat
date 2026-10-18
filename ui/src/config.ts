// Public settings baked in at build time by the host app (web or desktop). Never put secrets here.
const env = import.meta.env;

const LOCAL_SERVER = "http://localhost:8787";
const configuredServer = (env.VITE_SERVER_URL as string | undefined)?.trim() || undefined;

/** A hosted copy of the web app (not localhost, not the desktop app) built without VITE_SERVER_URL would call a server on the visitor's own computer. */
const hostedWithoutServer =
  !configuredServer &&
  typeof location !== "undefined" &&
  /^https?:$/.test(location.protocol) &&
  !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

export const config = {
  supabaseUrl: (env.VITE_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? "") as string,
  supabaseAnonKey: (env.VITE_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "") as string,
  serverUrl: (configuredServer ?? LOCAL_SERVER).replace(/\/$/, ""),
};

export const configError = !config.supabaseUrl || !config.supabaseAnonKey
  ? "Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local, then restart."
  : hostedWithoutServer
    ? "VITE_SERVER_URL is not set for this deploy. Add it in the host's environment variables (the chat server's https address) and redeploy."
    : null;

/** Set by the desktop app's preload script. Absent in a browser. */
type DesktopBridge = { platform: string; authRedirect?: string; shareBase?: string };
const desktop = (globalThis as { desktop?: DesktopBridge }).desktop;

/**
 * Where the links in confirmation and password-reset emails come back to. In a browser that is this page; in the
 * desktop app (whose own address, app://desktop, means nothing outside it) it is the app's multiuserchat:// link.
 */
export const authRedirectUrl = (): string => desktop?.authRedirect ?? `${location.origin}${location.pathname}`;

/** The address a "copy link" button builds on, followed by #/p/... In the desktop app, VITE_WEB_URL (if set) else its own link. */
export const shareBaseUrl = (): string => {
  const web = (env.VITE_WEB_URL as string | undefined)?.trim().replace(/\/$/, "");
  if (desktop) return web || desktop.shareBase || `${location.origin}${location.pathname}`;
  return `${location.origin}${location.pathname}`;
};

/** Shown in the app. The product name is not final. */
export const APP_NAME = "Multiuser Chat";
