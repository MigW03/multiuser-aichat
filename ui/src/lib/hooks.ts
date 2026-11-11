import { useEffect, useRef, useState, type PointerEvent } from "react";
import { LONG_PRESS_MS, LONG_PRESS_SLOP } from "./messageEdit.ts";
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

/** True while the device has no mouse hover (a phone or tablet): long-press stands in for hover. */
export function useTouch(): boolean {
  const query = "(hover: none)";
  const [touch, setTouch] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setTouch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return touch;
}

/** False while the browser says it has no connection. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
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

/** Pointer handlers for an element that opens something on a long press with a finger (a mouse is left alone). */
export function useLongPress(onPress: () => void, enabled: boolean) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const callback = useRef(onPress);
  callback.current = onPress;
  const clear = () => {
    clearTimeout(timer.current);
    start.current = null;
  };
  useEffect(() => clear, []);
  if (!enabled) return {};
  return {
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      start.current = { x: e.clientX, y: e.clientY };
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        start.current = null;
        callback.current();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > LONG_PRESS_SLOP) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    // The phone's own "copy / select" menu would open over ours.
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  };
}
