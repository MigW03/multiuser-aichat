import type { ChangePreview, FolderCaps, ProjectFolder } from "@mc/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { config } from "../config.ts";
import { useLive } from "../data.tsx";
import { supabase } from "../supabase.ts";

// The project's shared folder, as the app sees it: the folders and files the host shares. The row (name, online) comes
// from the database and is live for everyone in the project. Sharing and serving only exist in the desktop app; in a
// browser `folderBridge()` is null and the folder can be browsed but not shared.

export type SharedItem = { name: string; kind: "dir" | "file" };
export type LocalFolder = { linked: boolean; name: string | null; items: SharedItem[]; state: "off" | "connecting" | "connected" | "rejected" | "auth"; caps?: FolderCaps };

/** An AI change waiting for this computer's owner. The diff comes from the app itself, not from the chat server. */
export type PendingChange = { projectId: string; id: string; change: ChangePreview; askedBy: string; readFiles: number; expiresAt: number };

/** What the desktop app's preload script offers. The page never gets a path or a file, only these calls. */
export type FolderBridge = {
  setSession: (session: { serverUrl: string; token: string; userId: string; hostProjects: string[] } | null) => Promise<void>;
  get: (projectId: string) => Promise<LocalFolder>;
  /** Opens the native dialog to add folders or files. `skipped` names picks that couldn't be shared. */
  pick: (projectId: string, kind: "folder" | "files") => Promise<{ ok: true; name: string; items: SharedItem[]; skipped: string[] } | { ok: false; error: string | null }>;
  /** Stops sharing one item; the new name, or null when nothing is left. */
  remove: (projectId: string, name: string) => Promise<{ name: string | null }>;
  /** Starts serving a linked folder now (after it was registered with the server). */
  connect: (projectId: string) => Promise<void>;
  unlink: (projectId: string) => Promise<void>;
  onChange: (callback: (projectId: string) => void) => () => void;
  /** The host's switch for AI changes to files (off by default). Absent in older builds of the app. */
  setCaps?: (projectId: string, caps: Partial<FolderCaps>) => Promise<unknown>;
  /** AI changes waiting for the host's decision. */
  approvals?: () => Promise<PendingChange[]>;
  /** The host's click. The file is written by this call and by nothing else. */
  decide?: (projectId: string, id: string, approve: boolean) => Promise<boolean>;
  onApproval?: (callback: (view: PendingChange) => void) => () => void;
  onApprovalGone?: (callback: (gone: { projectId: string; id: string }) => void) => () => void;
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

/** The project's shared folder row, kept current by realtime. undefined while loading, null when none is shared. */
export function useProjectFolder(projectId: string | null) {
  return useLive<ProjectFolder | null>(async () => {
    if (!projectId) return null;
    const { data, error } = await supabase.from("project_folders").select("project_id, name, linked_by, linked_at, online").eq("project_id", projectId).maybeSingle();
    // Before the folder migration exists on the database there is no table: treat it as "nothing shared".
    if (error) return null;
    return (data as ProjectFolder | null) ?? null;
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
 * Tells the desktop app who is signed in and which projects they host, and keeps it current as the access token
 * is refreshed. The app then serves the folders linked on this computer for those projects.
 */
export function useFolderHost(userId: string, hostProjectIds: string[] | undefined) {
  const key = hostProjectIds ? [...hostProjectIds].sort().join(",") : null;
  const ids = useRef<string[]>([]);
  ids.current = hostProjectIds ?? [];

  const push = useCallback(
    (token: string | undefined) => {
      const bridge = folderBridge();
      if (!bridge || !token) return;
      void bridge.setSession({ serverUrl: config.serverUrl, token, userId, hostProjects: ids.current }).catch(() => undefined);
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
