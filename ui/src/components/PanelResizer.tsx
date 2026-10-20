import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { PREF, readPref, writePref } from "../lib/prefs.ts";

export const LEFT_MIN = 220;
export const LEFT_DEFAULT = 256; // keep in step with --left-width in styles.css
export const LEFT_MAX = 400;
/** The chat keeps its message column: the panel never takes more than this share of the window. */
const LEFT_MAX_SHARE = 0.35;
const KEY_STEP = 16;
const KEY_STEP_BIG = 48;

export const RIGHT_MIN = 260;
export const RIGHT_DEFAULT = 320; // the approved board's right column
export const RIGHT_MAX = 560;

type Range = { min: number; def: number; max: number };
const LEFT: Range = { min: LEFT_MIN, def: LEFT_DEFAULT, max: LEFT_MAX };
const RIGHT: Range = { min: RIGHT_MIN, def: RIGHT_DEFAULT, max: RIGHT_MAX };

/** Keeps a width inside the allowed range for the current window. Anything that is not a number falls back to the default. */
export function clampPanelWidth(value: unknown, windowWidth: number, range: Range = LEFT): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : range.def;
  const max = Math.max(range.min, Math.min(range.max, Math.floor(windowWidth * LEFT_MAX_SHARE)));
  return Math.round(Math.min(max, Math.max(range.min, n)));
}
export const clampLeftWidth = (value: unknown, windowWidth: number) => clampPanelWidth(value, windowWidth, LEFT);

/** A side panel's width: remembered per person, re-clamped when the window changes. */
function usePanelWidth(key: string, range: Range) {
  const [stored, setStored] = useState<number>(() => readPref<number>(key, range.def));
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const width = clampPanelWidth(stored, windowWidth, range);
  const max = clampPanelWidth(range.max, windowWidth, range);
  const set = (next: number, remember: boolean) => {
    const v = clampPanelWidth(next, windowWidth, range);
    setStored(v);
    if (remember) writePref(key, v);
  };
  return { width, max, min: range.min, def: range.def, set };
}

export const useLeftWidth = (userId: string) => usePanelWidth(PREF.leftWidth(userId), LEFT);
export const useRightWidth = (userId: string) => usePanelWidth(PREF.rightWidth(userId), RIGHT);

/**
 * Drag handle in the gap between a side panel and the chat: the left panel's on its right edge, the right column's on
 * its left edge. Arrow keys resize too (toward the chat makes it wider); double-click resets.
 */
export function PanelResizer({
  width,
  max,
  min = LEFT_MIN,
  def = LEFT_DEFAULT,
  side = "left",
  onChange,
}: {
  width: number;
  max: number;
  min?: number;
  def?: number;
  side?: "left" | "right";
  onChange: (next: number, remember: boolean) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);
  const dir = side === "left" ? 1 : -1; // the right column grows as the pointer moves left

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current) onChange(start.current.width + dir * (e.clientX - start.current.x), false);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    onChange(start.current.width + dir * (e.clientX - start.current.x), true);
    start.current = null;
    setDragging(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = (e.shiftKey ? KEY_STEP_BIG : KEY_STEP) * dir;
    const next = e.key === "ArrowLeft" ? width - step : e.key === "ArrowRight" ? width + step : e.key === "Home" ? min : e.key === "End" ? max : null;
    if (next === null) return;
    e.preventDefault();
    onChange(next, true);
  };

  return (
    <div
      className={`panel-resizer ${side} ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "Resize left panel" : "Resize shared folder panel"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onChange(def, true)}
      onKeyDown={onKeyDown}
    />
  );
}

// ---------------------------------------------------------------- the right column's split: Files above, Notes below

/** The least height, in px, either card keeps. */
export const SPLIT_MIN_PX = 120;
export const SPLIT_DEFAULT = 0.5;
const SPLIT_KEY_PX = 24;
const SPLIT_KEY_PX_BIG = 72;

/** The Files card's part of the column, kept so that both cards keep their minimum height. Anything that is not a number falls back to half. */
export function clampSplit(value: unknown, availablePx: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : SPLIT_DEFAULT;
  const lo = Math.min(0.5, SPLIT_MIN_PX / Math.max(1, availablePx));
  return Math.min(1 - lo, Math.max(lo, n));
}

/** How the column's height is shared between Files and Notes: remembered per person. */
export function useSplit(userId: string) {
  const [share, setShare] = useState<number>(() => clampSplit(readPref<number>(PREF.filesShare(userId), SPLIT_DEFAULT), Infinity));
  const set = (next: number, remember: boolean) => {
    const v = Math.round(next * 1000) / 1000;
    setShare(v);
    if (remember) writePref(PREF.filesShare(userId), v);
  };
  return { share, set };
}

/**
 * Drag handle in the gap between the Files card and the Notes card, styled like the column handles. `available` is the
 * height, in px, the two cards share; arrow keys move it by a step, Home and End go to the limits, double-click resets.
 */
export function SplitResizer({ share, available, onChange }: { share: number; available: () => number; onChange: (next: number, remember: boolean) => void }) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ y: number; share: number; room: number } | null>(null);
  const move = (y: number) => {
    const s = start.current!;
    return clampSplit(s.share + (y - s.y) / s.room, s.room);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { y: e.clientY, share, room: Math.max(1, available()) };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current) onChange(move(e.clientY), false);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    onChange(move(e.clientY), true);
    start.current = null;
    setDragging(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const room = Math.max(1, available());
    const step = (e.shiftKey ? SPLIT_KEY_PX_BIG : SPLIT_KEY_PX) / room;
    const next = e.key === "ArrowUp" ? share - step : e.key === "ArrowDown" ? share + step : e.key === "Home" ? 0 : e.key === "End" ? 1 : null;
    if (next === null) return;
    e.preventDefault();
    onChange(clampSplit(next, room), true);
  };

  return (
    <div
      className={`row-resizer ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize files and notes"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onChange(SPLIT_DEFAULT, true)}
      onKeyDown={onKeyDown}
    />
  );
}
