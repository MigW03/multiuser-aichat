import { useEffect, useState } from "react";

// Hash routes keep reload and shared links working on any static host, and in the desktop shell's app:// origin.
//   #/                         home (your own chats)
//   #/c/<chat>                 a home chat
//   #/p/<project>[/c/<chat>]   a project and one of its chats (/new: a chat not started yet)
//   #/p/<project>/settings     the project's settings, in place of the chat
//   #/join/<token>             an invite link
//   #/reset                    choose a new password (after the reset email)

export type Route =
  | { name: "home" }
  | { name: "homeChat"; chatId: string }
  | { name: "project"; projectId: string; chatId: string | null; draft?: boolean; view?: "settings" }
  | { name: "join"; token: string }
  | { name: "reset" };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "");
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^/p/(${UUID})/settings/?$`, "i").exec(path))) return { name: "project", projectId: m[1]!.toLowerCase(), chatId: null, view: "settings" };
  if ((m = new RegExp(`^/p/(${UUID})/new/?$`, "i").exec(path))) return { name: "project", projectId: m[1]!.toLowerCase(), chatId: null, draft: true };
  if ((m = new RegExp(`^/p/(${UUID})(?:/c/(${UUID}))?/?$`, "i").exec(path))) return { name: "project", projectId: m[1]!.toLowerCase(), chatId: m[2]?.toLowerCase() ?? null };
  if ((m = new RegExp(`^/c/(${UUID})/?$`, "i").exec(path))) return { name: "homeChat", chatId: m[1]!.toLowerCase() };
  if ((m = /^\/join\/([0-9a-f]{64})\/?$/i.exec(path))) return { name: "join", token: m[1]!.toLowerCase() };
  if (/^\/reset\/?$/.test(path)) return { name: "reset" };
  return { name: "home" };
}

export function routeHref(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
    case "homeChat":
      return `#/c/${route.chatId}`;
    case "project":
      return route.view === "settings" ? `#/p/${route.projectId}/settings` : route.chatId ? `#/p/${route.projectId}/c/${route.chatId}` : route.draft ? `#/p/${route.projectId}/new` : `#/p/${route.projectId}`;
    case "join":
      return `#/join/${route.token}`;
    case "reset":
      return "#/reset";
  }
}

export function navigate(route: Route, opts: { replace?: boolean } = {}) {
  const href = routeHref(route);
  if (opts.replace) history.replaceState(null, "", href);
  else if (location.hash !== href) location.hash = href;
  // replaceState doesn't fire hashchange
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

/** The token inside whatever the person pasted: a full invite link, a #/join/... fragment, or the bare token. */
export function tokenFromPasted(text: string): string | null {
  const m = /([0-9a-f]{64})/i.exec(text.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** Where "Back" goes from the project settings: the page the person came from, or the project's start page. */
let settingsReturn: string | null = null;
export function openProjectSettings(projectId: string) {
  settingsReturn = location.hash.startsWith(`#/p/${projectId}`) && !location.hash.endsWith("/settings") ? location.hash : null;
  navigate({ name: "project", projectId, chatId: null, view: "settings" });
}
export function closeProjectSettings(projectId: string) {
  if (settingsReturn) {
    location.hash = settingsReturn;
    settingsReturn = null;
  } else navigate({ name: "project", projectId, chatId: null });
}
