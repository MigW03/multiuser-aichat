import { useEffect, useRef, useState } from "react";
import { joinProject, onPresence } from "./projectChannel.ts";

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

/** A ref for an element that scrolls into view, centred, when `on` turns true (e.g. the settings row the person asked for). */
export function useScrollTo<T extends HTMLElement>(on: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (on) ref.current?.scrollIntoView({ block: "center" });
  }, [on]);
  return ref;
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
    const leave = joinProject(projectId, userId);
    const off = onPresence(projectId, (state) => setOnline(new Set(Object.keys(state))));
    return () => {
      off();
      leave();
    };
  }, [projectId, userId]);
  return online;
}
