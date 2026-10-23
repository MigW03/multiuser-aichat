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
