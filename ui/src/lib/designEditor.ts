import type { ProjectPresence } from "./projectChannel.ts";

// Small pure rules of design mode, kept apart from the components so they can be tested.

export type Editor = { id: string; name: string; since: number };

/**
 * Who edits a design: of the people who have it open and say they are editing it, the one who started first (ties go to
 * the smaller id). One editor at a time; everyone else watches the changes arrive.
 */
export function editorOf(state: Record<string, ProjectPresence>, path: string, skip?: string): Editor | null {
  let best: Editor | null = null;
  for (const [id, s] of Object.entries(state)) {
    if (id === skip || s.design !== path || !s.editing) continue;
    const since = typeof s.since === "number" ? s.since : 0;
    if (!best || since < best.since || (since === best.since && id < best.id)) best = { id, name: s.name || "Someone", since };
  }
  return best;
}

/** Whether a claim to edit made at `since` by `me` wins over the other editor. */
export function claimWins(me: string, since: number, other: Editor | null): boolean {
  return !other || since < other.since || (since === other.since && me < other.id);
}

/** Everyone who has the design open (for the dots in its top bar). */
export function viewersOf(state: Record<string, ProjectPresence>, path: string): { id: string; name: string; editing: boolean }[] {
  return Object.entries(state)
    .filter(([, s]) => s.design === path)
    .map(([id, s]) => ({ id, name: s.name || "Someone", editing: !!s.editing }));
}

/**
 * What someone changed on the canvas since their last message, for the AI: the changes in order, repeats of the same change
 * folded into one ("moved Logo" five times is one move), cut to `max` characters with the newest kept.
 */
export function summarizeEdits(list: string[], max = 560): string {
  const folded: string[] = [];
  for (const e of list) {
    const verb = /^(moved|nudged|resized|set \w+ of)\s/.exec(e)?.[0];
    const prev = folded.at(-1);
    if (prev === e || (verb && prev?.startsWith(verb) && prev.slice(verb.length).split(" ")[0] === e.slice(verb.length).split(" ")[0])) folded[folded.length - 1] = e;
    else folded.push(e);
  }
  let out = folded.join("; ");
  while (out.length > max && folded.length > 1) {
    folded.shift();
    out = `…; ${folded.join("; ")}`;
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/**
 * Arithmetic typed into a number field ("24+8", "120*2", "(10+6)/2"), the way Figma takes it. Numbers, + - * / and
 * brackets only; anything else is null. Never uses eval.
 */
export function evalMath(input: string): number | null {
  const s = input.replace(/px$/i, "").replace(/\s+/g, "");
  if (!s || s.length > 60 || !/^[\d.+\-*/()]+$/.test(s)) return null;
  let i = 0;
  const peek = () => s[i];
  function num(): number | null {
    if (peek() === "(") {
      i++;
      const v = sum();
      if (peek() !== ")") return null;
      i++;
      return v;
    }
    if (peek() === "-") {
      i++;
      const v = num();
      return v === null ? null : -v;
    }
    const m = /^\d*\.?\d+/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  }
  function product(): number | null {
    let v = num();
    while (v !== null && (peek() === "*" || peek() === "/")) {
      const op = s[i++];
      const r = num();
      if (r === null) return null;
      v = op === "*" ? v * r : r === 0 ? null : v / r;
    }
    return v;
  }
  function sum(): number | null {
    let v = product();
    while (v !== null && (peek() === "+" || peek() === "-")) {
      const op = s[i++];
      const r = product();
      if (r === null) return null;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const v = sum();
  return v !== null && i === s.length && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

/** How a layer is sized on one axis, in Figma's words: Hug its content, Fill its parent, or Fixed. */
export type SizeMode = "hug" | "fill" | "fixed";

/** The size mode of an element's width or height, given how its parent lays out (`row`, `column`, other). */
export function sizeModeOf(style: CSSStyleDeclaration, axis: "w" | "h", parentLayout: string): SizeMode {
  const v = axis === "w" ? style.width : style.height;
  const main = (parentLayout === "row" && axis === "w") || (parentLayout === "column" && axis === "h");
  if (main && /^1(\s|$)/.test(style.flex)) return "fill";
  if (v === "100%") return "fill";
  if (/^-?\d+(\.\d+)?px$/.test(v)) return "fixed";
  if (!v && axis === "w" && parentLayout !== "row" && style.alignSelf !== "flex-start" && style.alignSelf !== "start") return "fill";
  return "hug";
}

/** The inline style changes that put an element's width or height into a size mode. */
export function sizeModeStyle(mode: SizeMode, axis: "w" | "h", parentLayout: string, px: number): Record<string, string | null> {
  const prop = axis === "w" ? "width" : "height";
  const main = (parentLayout === "row" && axis === "w") || (parentLayout === "column" && axis === "h");
  if (mode === "fixed") return { [prop]: `${Math.max(1, Math.round(px))}px`, ...(main ? { flex: null } : {}) };
  if (mode === "fill") return main ? { [prop]: null, flex: "1" } : { [prop]: "100%", ...(axis === "w" ? { "align-self": null } : {}) };
  return { [prop]: axis === "w" && parentLayout !== "row" ? "fit-content" : null, ...(main ? { flex: null } : {}) };
}

/** A CSS colour as #rrggbb for a colour picker, or null when it is not a plain colour. */
export function toHex(color: string): string | null {
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${[...c.slice(1)].map((x) => x + x).join("")}`;
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(c);
  if (m) return `#${[m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, "0")).join("")}`;
  const named: Record<string, string> = { white: "#ffffff", black: "#000000", transparent: "#ffffff" };
  return named[c] ?? null;
}

/** Whether two spellings name the same design: the AI may leave out the shared folder's name ("designs/a.design.html"). */
export function sameDesignPath(a: unknown, b: string): boolean {
  if (typeof a !== "string" || !a) return false;
  return a === b || b.endsWith(`/${a}`) || a.endsWith(`/${b}`);
}

// ---- Figma-like controls over inline CSS: stroke, padding and alignment are read from the style's longhands and
// written back as the shortest plain CSS, so the file stays readable for people and the AI.

const px = (v: string): number => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v.trim());
  return m ? Number(m[1]) : 0;
};

export const SIDES = ["top", "right", "bottom", "left"] as const;
export type Side = (typeof SIDES)[number];
export type StrokeSides = "all" | Side | "custom";
export type LineStyle = "solid" | "dashed" | "dotted";
export type Stroke = { color: string; width: number; style: LineStyle; sides: StrokeSides };

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const sideOf = (st: CSSStyleDeclaration, s: Side) => {
  const k = cap(s);
  const read = (p: string) => st.getPropertyValue(`border-${s}-${p}`) || ((st as unknown as Record<string, string>)[`border${k}${cap(p)}`] ?? "");
  const style = read("style");
  const width = style && style !== "none" && style !== "hidden" ? (read("width") ? px(read("width")) : 3) : 0;
  return { width, style, color: read("color") };
};

/** The element's stroke (CSS border), or null when it has none. */
export function strokeOf(st: CSSStyleDeclaration): Stroke | null {
  const all = SIDES.map((s) => ({ side: s, ...sideOf(st, s) }));
  const on = all.filter((x) => x.width > 0);
  if (!on.length) return null;
  const first = on[0]!;
  const same = on.every((x) => x.width === first.width && x.style === first.style && x.color === first.color);
  const sides: StrokeSides = on.length === 4 && same ? "all" : on.length === 1 ? first.side : "custom";
  const style: LineStyle = first.style === "dashed" || first.style === "dotted" ? first.style : "solid";
  return { color: (first.color && toHex(first.color)) || first.color || "currentcolor", width: first.width, style, sides };
}

const BORDER_KEYS = ["border", "border-width", "border-style", "border-color", ...SIDES.flatMap((s) => [`border-${s}`, `border-${s}-width`, `border-${s}-style`, `border-${s}-color`])];

/** The style changes for a stroke (null removes it). "custom" keeps the sides that have one. */
export function strokeStyle(stroke: Stroke | null, current?: CSSStyleDeclaration): Record<string, string | null> {
  const out: Record<string, string | null> = Object.fromEntries(BORDER_KEYS.map((k) => [k, null]));
  if (!stroke) return out;
  const value = `${Math.max(0, Math.round(stroke.width * 10) / 10)}px ${stroke.style} ${stroke.color}`;
  if (stroke.sides === "all") out.border = value;
  else if (stroke.sides === "custom") {
    for (const s of SIDES) if (!current || sideOf(current, s).width > 0) out[`border-${s}`] = value;
  } else out[`border-${stroke.sides}`] = value;
  return out;
}

/** Padding as [top, right, bottom, left] in px. */
export function paddingOf(st: CSSStyleDeclaration): [number, number, number, number] {
  return SIDES.map((s) => px(st.getPropertyValue(`padding-${s}`) || ((st as unknown as Record<string, string>)[`padding${cap(s)}`] ?? ""))) as [number, number, number, number];
}

/** The shortest padding that gives these four sides. */
export function paddingStyle([t, r, b, l]: [number, number, number, number]): Record<string, string | null> {
  const n = (v: number) => `${Math.max(0, Math.round(v))}px`;
  const out: Record<string, string | null> = { padding: null, ...Object.fromEntries(SIDES.map((s) => [`padding-${s}`, null])) };
  if (t === r && r === b && b === l) out.padding = t > 0 ? n(t) : null;
  else if (t === b && r === l) out.padding = `${n(t)} ${n(r)}`;
  else out.padding = `${n(t)} ${n(r)} ${n(b)} ${n(l)}`;
  return out;
}

export type Place = "start" | "center" | "end";
type StackKind = "row" | "column" | "grid";

const placeOf = (v: string): Place => (/center/.test(v) ? "center" : /end/.test(v) ? "end" : "start");

/** Where children sit in a stack or grid, as Figma's 3x3 alignment box shows it (x across, y down). */
export function alignOf(st: CSSStyleDeclaration, kind: StackKind): { x: Place; y: Place; auto: boolean } {
  const auto = kind !== "grid" && st.justifyContent === "space-between";
  if (kind === "grid") return { x: placeOf(st.justifyItems), y: placeOf(st.alignItems), auto: false };
  const main = placeOf(st.justifyContent);
  const cross = placeOf(st.alignItems);
  return kind === "row" ? { x: main, y: cross, auto } : { x: cross, y: main, auto };
}

/**
 * The style changes for an alignment. Start along the cross axis of a vertical stack leaves the CSS default (children
 * stretch, which is how Fill width works); auto spacing is space-between on the main axis.
 */
export function alignStyle(kind: StackKind, x: Place, y: Place, auto: boolean): Record<string, string | null> {
  const flex = (p: Place) => (p === "start" ? "flex-start" : p === "end" ? "flex-end" : "center");
  if (kind === "grid") return { "justify-items": x === "start" ? null : x, "align-items": y === "start" ? null : y, "justify-content": null };
  const main = kind === "row" ? x : y;
  const cross = kind === "row" ? y : x;
  return {
    "justify-content": auto ? "space-between" : main === "start" ? null : flex(main),
    "align-items": kind === "column" && cross === "start" ? null : flex(cross),
  };
}
