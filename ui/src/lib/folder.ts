import type { ProjectFolder } from "@mc/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { config } from "../config.ts";
import { useLive } from "../data.tsx";
import { supabase } from "../supabase.ts";

// The project's shared folder, as the app sees it: the folders and files the host shares. The row (name, online) comes
// from the database and is live for everyone in the project. Sharing and serving only exist in the desktop app; in a
// browser `folderBridge()` is null and the folder can be browsed but not shared.

export type SharedItem = { name: string; kind: "dir" | "file" };
export type LocalFolder = { linked: boolean; name: string | null; items: SharedItem[]; state: "off" | "connecting" | "connected" | "rejected" | "auth" };

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
};

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
