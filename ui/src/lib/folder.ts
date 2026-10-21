import type { ChangePreview, FolderCaps, ProjectShare, ProjectShareHost, ScriptsInfo } from "@mc/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { config } from "../config.ts";
import { useLive } from "../data.tsx";
import { supabase } from "../supabase.ts";

// A project's shared files, as the app sees them: folders and files that people share from their own computers. What is
// shared, by whom, whether it was approved and whether the owner's app is online come from the database and are live for
// everyone in the project. Sharing and serving only exist in the desktop app; in a browser `folderBridge()` is null and
// the files can be browsed but not shared.

export type SharedItem = { name: string; kind: "dir" | "file" };
/** An item shared from this computer. `syncing`: the server has not answered for it yet. `pending`: waiting for the host or an admin. */
export type LocalItem = SharedItem & { key: string; status: "syncing" | "pending" | "active" };
export type LocalFolder = { linked: boolean; name: string | null; items: LocalItem[]; state: "off" | "connecting" | "connected" | "rejected" | "auth"; caps?: FolderCaps; /** Why the server refused this computer's items, when it did. */ error?: string | null };

/** What the desktop app tells the page about something dropped on the files panel: names only. */
export type Dropped = { ok: true; items: SharedItem[]; skipped: string[] } | { ok: false; error: string };
export type PickResult = { ok: true; name: string; items: LocalItem[]; skipped: string[] } | { ok: false; error: string | null };

/** An AI change waiting for this computer's owner. The diff comes from the app itself, not from the chat server. */
export type PendingChange = { projectId: string; id: string; change: ChangePreview; askedBy: string; readFiles: number; expiresAt: number };

/** The package.json scripts of what this person shares from this computer. The page names a folder (by its key) and a script; the app reads package.json and builds the command itself. */
export type ScriptsBridge = {
  /** `list: false` asks for the runs only (the scripts come back empty): cheaper while a script is printing. */
  get: (projectId: string, list?: boolean) => Promise<ScriptsInfo>;
  /** Only asks: the request waits in the approval dock and the script starts when the owner approves it there and confirms in the app's own window. */
  run: (projectId: string, key: string, name: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Withdraws a Run that has not been approved yet. */
  cancel: (projectId: string, key: string, name: string) => Promise<void>;
  stop: (projectId: string, key: string, name: string) => Promise<boolean>;
  log: (projectId: string, key: string, name: string) => Promise<string | null>;
  clear: (projectId: string, key: string, name: string) => Promise<void>;
  /** The Scripts tab was looked at: a crash is not news any more. */
  seen: (projectId: string) => Promise<void>;
  onChange: (callback: (projectId: string) => void) => () => void;
};

/** What the desktop app's preload script offers. The page never gets a path or a file, only these calls. */
export type FolderBridge = {
  setSession: (session: { serverUrl: string; token: string; userId: string; projects: string[] } | null) => Promise<void>;
  get: (projectId: string) => Promise<LocalFolder>;
  /** Opens the native dialog to add folders or files. `skipped` names picks that couldn't be shared. */
  pick: (projectId: string, kind: "folder" | "files") => Promise<PickResult>;
  /** Stops sharing one item of this computer's, by the name the project gave it. The new name, or null when nothing is left. */
  remove: (projectId: string, name: string) => Promise<{ name: string | null }>;
  /** Something was dragged onto an element marked data-files-drop. Only names arrive; the paths stay in the app until dropCommit. Absent in older builds of the app. */
  onDrop?: (callback: (projectId: string, dropped: Dropped) => void) => () => void;
  /** Shares what was dropped, after the page showed the notice when one is due. */
  dropCommit?: (projectId: string) => Promise<PickResult>;
  dropCancel?: (projectId: string) => Promise<void>;
  /** The server refused what this computer reported, for example too many items in the project. */
  onItemsError?: (callback: (projectId: string, code: string) => void) => () => void;
  onChange: (callback: (projectId: string) => void) => () => void;
  /** This person's switch for AI changes to what they share (off by default). Absent in older builds of the app. */
  setCaps?: (projectId: string, caps: Partial<FolderCaps>) => Promise<unknown>;
  /** AI changes waiting for this person's decision. */
  approvals?: () => Promise<PendingChange[]>;
  /** This person's click. The file is written by this call and by nothing else. */
  decide?: (projectId: string, id: string, approve: boolean) => Promise<boolean>;
  onApproval?: (callback: (view: PendingChange) => void) => () => void;
  onApprovalGone?: (callback: (gone: { projectId: string; id: string }) => void) => () => void;
  /** Run and stop the scripts in package.json. Absent in older builds of the app. */
  scripts?: ScriptsBridge;
};

/** Connected tools (MCP), as the desktop app reports them. They belong to the signed-in person, not to a project. Environment values never reach the page, only their names. */
export type McpTool = { name: string; description: string; enabled: boolean; usable: boolean; note?: string };
export type McpServer = { name: string; command: string; envKeys: string[]; enabled: boolean; status: "off" | "starting" | "ready" | "failed"; error?: string; tools: McpTool[] };
export type McpInfo = { servers: McpServer[]; secureStorage: boolean; /** The app's connection to the chat server: the AI can use the tools only while "connected". */ link: "off" | "connecting" | "connected" | "auth" };
export type McpBridge = {
  setSession: (session: { serverUrl: string; token: string; userId: string } | null) => Promise<void>;
  get: () => Promise<McpInfo>;
  /** `command` is the command line as typed and `env` is KEY=value lines; the app splits them and asks the person to confirm what will run, in its own window. error null = they cancelled. */
  add: (server: { name: string; command: string; env: string }) => Promise<{ ok: true; info: McpInfo } | { ok: false; error: string | null }>;
  remove: (name: string) => Promise<McpInfo>;
  setServer: (name: string, enabled: boolean) => Promise<McpInfo>;
  setTool: (name: string, tool: string, enabled: boolean) => Promise<McpInfo>;
  retry: (name: string) => Promise<McpInfo>;
  onChange: (callback: () => void) => () => void;
};

export const mcpBridge = (): McpBridge | null => (globalThis as { desktop?: { mcp?: McpBridge } }).desktop?.mcp ?? null;

/** The person's connected tools, current as the app starts, stops and changes them. null in a browser or an older app. */
export function useMcp(): { info: McpInfo | null; set: (info: McpInfo) => void } {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const mcp = mcpBridge();
  useEffect(() => {
    if (!mcp) return setInfo(null);
    let live = true;
    const load = () => void mcp.get().then((v) => live && setInfo(v), () => undefined);
    load();
    const off = mcp.onChange(load);
    return () => {
      live = false;
      off();
    };
  }, [mcp]);
  return { info, set: setInfo };
}

/**
 * Tells the desktop app who is signed in (and keeps its access token fresh) so it can start this person's MCP servers and
 * connect them to the chat server. Signing out, or leaving the app screen, stops them.
 */
export function useMcpHost(userId: string) {
  useEffect(() => {
    const bridge = mcpBridge();
    if (!bridge) return;
    let live = true;
    const push = (token: string | undefined) => {
      if (live && token) void bridge.setSession({ serverUrl: config.serverUrl, token, userId }).catch(() => undefined);
    };
    void supabase.auth.getSession().then(({ data }) => push(data.session?.access_token));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => push(session?.access_token));
    return () => {
      live = false;
      data.subscription.unsubscribe();
      void bridge.setSession(null).catch(() => undefined);
    };
  }, [userId]);
}

export const folderBridge = (): FolderBridge | null => (globalThis as { desktop?: { folder?: FolderBridge } }).desktop?.folder ?? null;

/** An item someone shares, with the name of the person and whether their app is online. */
export type ShareRow = ProjectShare & { owner_name: string; online: boolean };

/**
 * The project's shared items, kept current by realtime: approved ones for everyone, and requests for the person who made
 * them and the people who decide (the database decides who sees what). undefined while loading; empty when nothing is shared
 * or before the sharing migration exists on the database.
 */
export function useProjectShares(projectId: string | null) {
  return useLive<ShareRow[]>(async () => {
    if (!projectId) return [];
    const [shares, hosts] = await Promise.all([
      supabase.from("project_shares").select("id, project_id, owner_id, name, kind, status, created_at, owner:profiles!owner_id(display_name)").eq("project_id", projectId).order("created_at"),
      supabase.from("project_share_hosts").select("project_id, owner_id, online, linked_at").eq("project_id", projectId),
    ]);
    if (shares.error || hosts.error) return [];
    const online = new Map(((hosts.data ?? []) as ProjectShareHost[]).map((h) => [h.owner_id, h.online]));
    return ((shares.data ?? []) as unknown as (ProjectShare & { owner: { display_name: string } | null })[]).map(({ owner, ...s }) => ({ ...s, owner_name: owner?.display_name ?? "Someone", online: online.get(s.owner_id) === true }));
  }, [projectId]);
}

/** What this computer knows about the folder: whether it is linked here and whether it is connected to the server. Desktop only. */
export function useLocalFolder(projectId: string | null): LocalFolder | null {
  const [info, setInfo] = useState<LocalFolder | null>(null);
  const bridge = folderBridge();
  useEffect(() => {
    if (!bridge || !projectId) return setInfo(null);
    let live = true;
    const load = () => void bridge.get(projectId).then((v) => live && setInfo(v), () => undefined);
    load();
    const off = bridge.onChange((id) => id === projectId && load());
    return () => {
      live = false;
      off();
    };
  }, [bridge, projectId]);
  return info;
}

/**
 * Tells the desktop app who is signed in and which projects they belong to, and keeps it current as the access token
 * is refreshed. The app then serves what this person shares on this computer in those projects.
 */
export function useFolderHost(userId: string, projectIds: string[] | undefined) {
  const key = projectIds ? [...projectIds].sort().join(",") : null;
  const ids = useRef<string[]>([]);
  ids.current = projectIds ?? [];

  const push = useCallback(
    (token: string | undefined) => {
      const bridge = folderBridge();
      if (!bridge || !token) return;
      void bridge.setSession({ serverUrl: config.serverUrl, token, userId, projects: ids.current }).catch(() => undefined);
    },
    [userId],
  );

  useEffect(() => {
    if (key === null || !folderBridge()) return;
    let live = true;
    void supabase.auth.getSession().then(({ data }) => live && push(data.session?.access_token));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => push(session?.access_token));
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, [key, push]);

  // Signing out (or leaving the app screen) stops serving.
  useEffect(() => () => void folderBridge()?.setSession(null).catch(() => undefined), [userId]);
}

/** AI changes waiting for this computer's owner to approve or decline. Empty in a browser. */
export function useHostApprovals(): PendingChange[] {
  const [pending, setPending] = useState<PendingChange[]>([]);
  const bridge = folderBridge();
  useEffect(() => {
    if (!bridge?.approvals || !bridge.onApproval || !bridge.onApprovalGone) return;
    let live = true;
    void bridge.approvals().then((list) => live && setPending(list), () => undefined);
    const offAdd = bridge.onApproval((view) => setPending((cur) => [...cur.filter((p) => p.id !== view.id), view]));
    const offGone = bridge.onApprovalGone(({ projectId, id }) => setPending((cur) => cur.filter((p) => !(p.projectId === projectId && p.id === id))));
    return () => {
      live = false;
      offAdd();
      offGone();
    };
  }, [bridge]);
  return pending;
}

/**
 * The package.json scripts of the folders this person shares here, and how each one is doing, current as they start and
 * end. `version` changes whenever something did (an open log reads again then). null info: not in the desktop app, an older
 * app, or `enabled` is false.
 */
export function useScripts(projectId: string | null, enabled: boolean): { info: ScriptsInfo | null; version: number; reload: () => void } {
  const [info, setInfo] = useState<ScriptsInfo | null>(null);
  const [version, setVersion] = useState(0);
  const [tick, setTick] = useState(0);
  const folder = folderBridge();
  const bridge = folder?.scripts ?? null;
  useEffect(() => {
    if (!bridge || !folder || !projectId || !enabled) return setInfo(null);
    let live = true;
    // `list`: read package.json again. Output only changes the runs, which is cheaper to ask for.
    const load = (list: boolean) =>
      void bridge.get(projectId, list).then(
        (v) => {
          if (!live) return;
          setInfo((cur) => ({ scripts: list || !cur ? v.scripts : cur.scripts, runs: v.runs }));
          setVersion((n) => n + 1);
        },
        () => undefined,
      );
    load(true);
    const offRuns = bridge.onChange((id) => id === projectId && load(false));
    const offFolder = folder.onChange((id) => id === projectId && load(true));
    const onFocus = () => load(true); // package.json may have been edited meanwhile
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      offRuns();
      offFolder();
      window.removeEventListener("focus", onFocus);
    };
  }, [bridge, folder, projectId, enabled, tick]);
  return { info, version, reload: () => setTick((n) => n + 1) };
}
