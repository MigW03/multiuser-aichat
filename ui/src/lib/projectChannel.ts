import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../supabase.ts";

// One realtime channel per open project (`project:<id>`, members only): presence for the green dots and for who has which
// design open, and broadcasts about designs. Several parts of the page use it, so it is shared and counted.

/** What each person's page says about itself. `design`: the design file it has open; `editing`: it is the one editing it. */
export type ProjectPresence = { at: number; design?: string | null; editing?: boolean; since?: number; name?: string };

type Listener = (payload: Record<string, unknown>) => void;
const EVENTS = ["design_saved", "design_list", "design_ai", "design_ask", "design_handover"] as const;
export type ProjectEvent = (typeof EVENTS)[number];

type Entry = {
  channel: RealtimeChannel;
  users: number;
  joined: boolean;
  mine: ProjectPresence;
  listeners: Map<string, Set<Listener>>;
  presence: Set<(state: Record<string, ProjectPresence>) => void>;
};

const open = new Map<string, Entry>();

function stateOf(e: Entry): Record<string, ProjectPresence> {
  const raw = e.channel.presenceState() as Record<string, ProjectPresence[]>;
  const out: Record<string, ProjectPresence> = {};
  for (const [user, metas] of Object.entries(raw)) {
    // A person with two windows open shows twice; the one editing wins, then the newest.
    const pick = [...metas].sort((a, b) => Number(!!b.editing) - Number(!!a.editing) || (b.at ?? 0) - (a.at ?? 0))[0];
    if (pick) out[user] = pick;
  }
  return out;
}

function entry(projectId: string, userId: string): Entry {
  const hit = open.get(projectId);
  if (hit) return hit;
  const channel = supabase.channel(`project:${projectId}`, { config: { private: true, presence: { key: userId } } });
  const e: Entry = { channel, users: 0, joined: false, mine: { at: Date.now() }, listeners: new Map(), presence: new Set() };
  channel.on("presence", { event: "sync" }, () => {
    const s = stateOf(e);
    for (const f of e.presence) f(s);
  });
  for (const ev of EVENTS) {
    channel.on("broadcast", { event: ev }, (msg: { payload?: Record<string, unknown> }) => {
      for (const f of e.listeners.get(ev) ?? []) f(msg.payload ?? {});
    });
  }
  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      e.joined = true;
      void channel.track(e.mine);
    }
  });
  open.set(projectId, e);
  return e;
}

/** Joins the project's channel; call the returned function to leave. */
export function joinProject(projectId: string, userId: string): () => void {
  const e = entry(projectId, userId);
  e.users++;
  return () => {
    e.users--;
    if (e.users > 0) return;
    open.delete(projectId);
    void supabase.removeChannel(e.channel);
  };
}

export function onPresence(projectId: string, f: (state: Record<string, ProjectPresence>) => void): () => void {
  const e = open.get(projectId);
  if (!e) return () => undefined;
  e.presence.add(f);
  f(stateOf(e));
  return () => void e.presence.delete(f);
}

export function onProjectEvent(projectId: string, event: ProjectEvent, f: Listener): () => void {
  const e = open.get(projectId);
  if (!e) return () => undefined;
  const set = e.listeners.get(event) ?? new Set();
  set.add(f);
  e.listeners.set(event, set);
  return () => void set.delete(f);
}

/** Changes what this page says about itself (merged into what it said before). */
export function setPresence(projectId: string, patch: Partial<ProjectPresence>) {
  const e = open.get(projectId);
  if (!e) return;
  e.mine = { ...e.mine, ...patch, at: Date.now() };
  if (e.joined) void e.channel.track(e.mine);
}

export function sendProjectEvent(projectId: string, event: ProjectEvent, payload: Record<string, unknown>) {
  const e = open.get(projectId);
  if (e?.joined) void e.channel.send({ type: "broadcast", event, payload });
}
