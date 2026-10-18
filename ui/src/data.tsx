import type { ChatSummary, ModelChoice, Person, ProjectMember, ProjectSummary, ProviderId, Reasoning } from "@mc/shared";
import { isProvider, isReasoning } from "@mc/shared";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type DependencyList } from "react";
import { supabase } from "./supabase.ts";

export type Me = {
  id: string;
  display_name: string;
  email: string;
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

export function useRealtimeLists(userId: string) {
  useEffect(() => {
    const channel = supabase.channel(`lists:${userId}`);
    for (const table of ["messages", "chats", "projects", "project_members", "chat_members", "project_folders"]) {
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

type MemberRow = { user_id: string; role: ProjectMember["role"]; joined_at: string; profiles: { id: string; display_name: string; email: string } | null };

export async function fetchProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const rows = await must<MemberRow[]>(
    supabase.from("project_members").select("user_id, role, joined_at, profiles(id, display_name, email)").eq("project_id", projectId).order("joined_at") as never,
    "the people in this project",
  );
  return rows.filter((r) => r.profiles).map((r) => ({ id: r.user_id, display_name: r.profiles!.display_name, email: r.profiles!.email, role: r.role, joined_at: r.joined_at }));
}

export async function fetchChatPeople(chatId: string): Promise<(Person & { joined_at: string })[]> {
  const rows = await must<{ user_id: string; joined_at: string; profiles: Person | null }[]>(
    supabase.from("chat_members").select("user_id, joined_at, profiles(id, display_name)").eq("chat_id", chatId).order("joined_at") as never,
    "the people in this chat",
  );
  return rows.filter((r) => r.profiles).map((r) => ({ id: r.user_id, display_name: r.profiles!.display_name, joined_at: r.joined_at }));
}

export async function fetchMe(userId: string): Promise<Me> {
  const { data, error } = await supabase.from("profiles").select("id, display_name, email, ai_provider, ai_model, ai_reasoning").eq("id", userId).single();
  if (error || !data) throw new Error("Could not load your profile.");
  return {
    id: data.id,
    display_name: data.display_name,
    email: data.email,
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
  openSettings: (tab?: "account" | "key" | "appearance") => void;
  openAddKey: () => void;
  /** Open the "invite someone" dialog for a project or a home chat. */
  openInvite: (target: { kind: "project"; projectId: string } | { kind: "chat"; chatId: string }) => void;
  /** The shared folder panel on the right of a project's chats. */
  folderPanel: { open: boolean; toggle: () => void };
};

export const AppContext = createContext<AppContextValue | null>(null);
export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error("useApp outside AppContext");
  return v;
}
