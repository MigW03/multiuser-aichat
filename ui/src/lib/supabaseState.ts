import type { SupabaseState } from "@mc/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";

// What the page knows about the Supabase tab of a project: its link, how this person's own Supabase connection is doing, and
// whether they may change the link. Kept current: on mount, when the window gets focus, when something here changes it, and
// every 3 s while they sign in to Supabase in the browser.

const CHANGED = "nido:supabase-changed";
/** Tells every open view of this project's Supabase state to read it again (after linking, unlinking, connecting). */
export const notifySupabaseChanged = () => window.dispatchEvent(new Event(CHANGED));

const WATCH_MS = 10 * 60_000;

export function useSupabaseState(projectId: string | null) {
  const [state, setState] = useState<SupabaseState | null>(null);
  const [failed, setFailed] = useState(false);
  const [watchUntil, setWatchUntil] = useState(0);
  const live = useRef(true);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const next = await api.supabaseState(projectId);
      if (live.current) {
        setState(next);
        setFailed(false);
      }
    } catch {
      if (live.current) setFailed(true);
    }
  }, [projectId]);

  useEffect(() => {
    live.current = true;
    setState(null);
    setFailed(false);
    void load();
    const again = () => void load();
    window.addEventListener("focus", again);
    window.addEventListener(CHANGED, again);
    return () => {
      live.current = false;
      window.removeEventListener("focus", again);
      window.removeEventListener(CHANGED, again);
    };
  }, [load]);

  const connecting = state?.mine.state === "connecting";
  const busy = connecting || Date.now() < watchUntil;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [busy, load]);

  return {
    state,
    /** True until the first answer, and when it could not be had. */
    loaded: state !== null,
    failed: failed && state === null,
    reload: load,
    /** Keep reading for a while, e.g. while the person signs in in the browser. */
    watch: () => setWatchUntil(Date.now() + WATCH_MS),
  };
}
export type SupabaseHook = ReturnType<typeof useSupabaseState>;
