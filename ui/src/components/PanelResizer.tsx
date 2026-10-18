import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { PREF, readPref, writePref } from "../lib/prefs.ts";

export const LEFT_MIN = 220;
export const LEFT_DEFAULT = 256; // keep in step with --left-width in styles.css
export const LEFT_MAX = 400;
/** The chat keeps its message column: the panel never takes more than this share of the window. */
const LEFT_MAX_SHARE = 0.35;
const KEY_STEP = 16;
const KEY_STEP_BIG = 48;

/** Keeps a width inside the allowed range for the current window. Anything that is not a number falls back to the default. */
export function clampLeftWidth(value: unknown, windowWidth: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : LEFT_DEFAULT;
  const max = Math.max(LEFT_MIN, Math.min(LEFT_MAX, Math.floor(windowWidth * LEFT_MAX_SHARE)));
  return Math.round(Math.min(max, Math.max(LEFT_MIN, n)));
}

/** The left panel's width: remembered per person, re-clamped when the window changes. */
export function useLeftWidth(userId: string) {
  const [stored, setStored] = useState<number>(() => readPref<number>(PREF.leftWidth(userId), LEFT_DEFAULT));
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const width = clampLeftWidth(stored, windowWidth);
  const max = clampLeftWidth(LEFT_MAX, windowWidth);
  const set = (next: number, remember: boolean) => {
    const v = clampLeftWidth(next, windowWidth);
    setStored(v);
    if (remember) writePref(PREF.leftWidth(userId), v);
  };
  return { width, max, set };
}

/** Drag handle in the gap between the left panel and the chat. Arrow keys resize too; double-click resets. */
export function PanelResizer({ width, max, onChange }: { width: number; max: number; onChange: (next: number, remember: boolean) => void }) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current) onChange(start.current.width + e.clientX - start.current.x, false);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    onChange(start.current.width + e.clientX - start.current.x, true);
    start.current = null;
    setDragging(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    const next = e.key === "ArrowLeft" ? width - step : e.key === "ArrowRight" ? width + step : e.key === "Home" ? LEFT_MIN : e.key === "End" ? max : null;
    if (next === null) return;
    e.preventDefault();
    onChange(next, true);
  };

  return (
    <div
      className={`panel-resizer ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize left panel"
      aria-valuemin={LEFT_MIN}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onChange(LEFT_DEFAULT, true)}
      onKeyDown={onKeyDown}
    />
  );
}
