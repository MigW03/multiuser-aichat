import type { ChatSummary, DesignRef, ModelChoice, Person, ProjectMember, ProjectSummary, ProviderId, Reasoning } from "@mc/shared";
import { isProvider, isReasoning } from "@mc/shared";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type DependencyList } from "react";
import { supabase } from "./supabase.ts";

export type Me = {
  id: string;
  display_name: string;
  email: string;
  avatar_url: string | null;
  ai_provider: ProviderId | null;
  ai_model: string | null;
  ai_reasoning: Reasoning | null;
};

// ------------------------------------------------------------------ live queries
// One realtime channel watches the tables the lists are built from. Any change re-runs the queries on screen
// (debounced), so unread badges, previews, member lists and project names stay current without per-screen wiring.

const bus = new EventTarget();
let pending: ReturnType<typeof setTimeout> | undefined;
export function notifyChanged() {
  clearTimeout(pending);
  pending = setTimeout(() => bus.dispatchEvent(new Event("changed")), 250);
}

/** Runs `callback` whenever the watched tables change (a message arrived, a chat or project changed). Returns the way to stop. */
export function onChanged(callback: () => void): () => void {
  bus.addEventListener("changed", callback);
  return () => bus.removeEventListener("changed", callback);
}

export function useRealtimeLists(userId: string) {
  useEffect(() => {
    const channel = supabase.channel(`lists:${userId}`);
    for (const table of ["messages", "chats", "projects", "project_members", "chat_members", "project_shares", "project_share_hosts", "project_notes"]) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, notifyChanged);
    }
    channel.subscribe((status) => status === "SUBSCRIBED" && notifyChanged());
    return () => void supabase.removeChannel(channel);
  }, [userId]);
}

export type Live<T> = { data: T | undefined; error: string | null; reload: () => void };

/** Runs `fetcher` now, whenever `deps` change, and whenever the watched tables change. Keeps old data while reloading. */
export function useLive<T>(fetcher: () => Promise<T>, deps: DependencyList): Live<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const generation = useRef(0);

  const reload = useCallback(() => {
    const mine = ++generation.current;
    fetcherRef.current().then(
      (value) => {
        if (mine !== generation.current) return; // a newer request is in flight
        setData(value);
        setError(null);
      },
      (e: unknown) => mine === generation.current && setError(e instanceof Error ? e.message : "Could not load."),
    );
  }, []);

  useEffect(() => {
    setData(undefined);
    reload();
    bus.addEventListener("changed", reload);
    return () => {
      generation.current++;
      bus.removeEventListener("changed", reload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, reload };
}

// ------------------------------------------------------------------ queries

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error || data === null) throw new Error(`Could not load ${what}.`);
  return data;
}

export const fetchProjects = () => must<ProjectSummary[]>(supabase.rpc("project_list") as never, "your projects");
export const fetchChats = (projectId: string | null) =>
  must<ChatSummary[]>(supabase.rpc("chat_list", { p_project: projectId }) as never, "your chats").then((rows) =>
    // Pinned first, then most recent activity.
    [...rows].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.last_message_at.localeCompare(a.last_message_at)),
  );

type MemberRow = { user_id: string; role: ProjectMember["role"]; joined_at: string; profiles: { id: string; display_name: string; email: string; avatar_url: string | null } | null };

export async function fetchProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const rows = await must<MemberRow[]>(
    supabase.from("project_members").select("user_id, role, joined_at, profiles(id, display_name, email, avatar_url)").eq("project_id", projectId).order("joined_at") as never,
    "the people in this project",
  );
  return rows.filter((r) => r.profiles).map((r) => ({ id: r.user_id, display_name: r.profiles!.display_name, email: r.profiles!.email, avatar_url: r.profiles!.avatar_url, role: r.role, joined_at: r.joined_at }));
}

export async function fetchChatPeople(chatId: string): Promise<(Person & { joined_at: string })[]> {
  const rows = await must<{ user_id: string; joined_at: string; profiles: Person | null }[]>(
    supabase.from("chat_members").select("user_id, joined_at, profiles(id, display_name, avatar_url)").eq("chat_id", chatId).order("joined_at") as never,
    "the people in this chat",
  );
  return rows.filter((r) => r.profiles).map((r) => ({ id: r.user_id, display_name: r.profiles!.display_name, avatar_url: r.profiles!.avatar_url ?? null, joined_at: r.joined_at }));
}

export async function fetchMe(userId: string): Promise<Me> {
  const { data, error } = await supabase.from("profiles").select("id, display_name, email, avatar_url, ai_provider, ai_model, ai_reasoning").eq("id", userId).single();
  if (error || !data) throw new Error("Could not load your profile.");
  return {
    id: data.id,
    display_name: data.display_name,
    email: data.email,
    avatar_url: data.avatar_url ?? null,
    ai_provider: isProvider(data.ai_provider) ? data.ai_provider : null,
    ai_model: data.ai_model,
    ai_reasoning: isReasoning(data.ai_reasoning) ? data.ai_reasoning : null,
  };
}

// ------------------------------------------------------------------ app context

export type AppContextValue = {
  me: Me;
  reloadMe: () => void;
  /** Providers the person has saved a key for, with the last 4 characters. null while loading. */
  keys: { provider: ProviderId; hint: string }[] | null;
  reloadKeys: () => void;
  /** The model the next message uses. null until there is a key and a pick. Saved on the profile. */
  choice: ModelChoice | null;
  setChoice: (c: ModelChoice) => void;
  /** `focus`: with the "mcp" tab, the server to scroll to (a remote server's id, or `local:<name>`). */
  openSettings: (tab?: "account" | "key" | "appearance" | "mcp", focus?: string) => void;
  openAddKey: () => void;
  /** Open the "invite someone" dialog for a project or a home chat. */
  openInvite: (target: { kind: "project"; projectId: string } | { kind: "chat"; chatId: string }) => void;
  /** The files column on the right of a project's chats. `drawer`: a small screen shows it as a drawer. */
  folderPanel: { open: boolean; drawer: boolean; toggle: () => void };
  /** The preview of a localhost page in the main panel. `available`: only the desktop app has it. `show` without an address opens it empty. */
  preview: { available: boolean; open: boolean; show: (url?: string) => void; close: () => void };
  /**
   * A shared file shown in the middle of the main panel, in place of the chat. `hasAny`: the project shares something, so a file
   * name in an answer can be tried. `open` with `guess`: the path is as an answer wrote it, so it is looked for under each shared folder.
   */
  files: {
    hasAny: boolean;
    path: string | null;
    open: (path: string, guess?: boolean) => void;
    close: () => void;
    /** Whether an HTML file can be run with its scripts: only in the desktop app, for a file this computer shares. */
    canRun: (path: string) => boolean;
    /** Runs it: the app asks first, then the page opens in the preview beside the chat. */
    run: (path: string) => void;
  };
  /** Design mode: one of the project's designs (or an older design file in a shared folder) on the canvas beside the chat. */
  design: DesignCtx;
};

export type DesignCtx = {
  /** A project is open, so designs can be made and opened. */
  available: boolean;
  /** The design open on the canvas, if any. */
  path: string | null;
  /** `select`: layers to select once it is drawn; `build`: open the "Build in code" dialog. */
  open: (path: string, opts?: { select?: string[]; build?: boolean }) => void;
  /** The list of designs, with "New design". */
  pick: () => void;
  create: () => void;
  close: () => void;
  /** What the next message is about: the open design and the layers picked with "Ask AI", or a request for a new design. */
  chip: DesignRef | null;
  setChip: (ref: DesignRef | null) => void;
  /** The marker for a message being sent: the chip and the canvas edits since the last message. Uses them up. */
  take: () => string | null;
};

export const AppContext = createContext<AppContextValue | null>(null);
export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error("useApp outside AppContext");
  return v;
}
