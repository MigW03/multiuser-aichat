import { useEffect, useState } from "react";
import { supabase } from "../supabase.ts";

/** True while the window is narrower than `max` px. */
export function useNarrow(max = 820): boolean {
  const query = `(max-width: ${max}px)`;
  const [narrow, setNarrow] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return narrow;
}

/**
 * Who has the project open right now, from realtime presence on `project:<id>`.
 * Presence is a hint for the green dots only; nothing is decided from it.
 */
export function useProjectPresence(projectId: string | null, userId: string): Set<string> {
  const [online, setOnline] = useState<Set<string>>(new Set());
  useEffect(() => {
    setOnline(new Set());
    if (!projectId) return;
    const channel = supabase.channel(`project:${projectId}`, { config: { private: true, presence: { key: userId } } });
    const sync = () => setOnline(new Set(Object.keys(channel.presenceState())));
    channel
      .on("presence", { event: "sync" }, sync)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void channel.track({ at: Date.now() });
      });
    return () => void supabase.removeChannel(channel);
  }, [projectId, userId]);
  return online;
}
