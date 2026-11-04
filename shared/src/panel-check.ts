import { PANEL_FUNCTION_KINDS, PANEL_ICONS, PANEL_LIMITS as L, isReadTool, viewIsAllowed, type PanelDraft, type PanelErrorCode, type PanelFunction, type PanelMeta, type PanelSource } from "./panels.ts";

// The checks every custom panel passes, in the AI's tool on the chat server and again in the desktop app before anything is
// kept: one copy, so what one side accepts the other accepts too. Nothing is repaired: anything odd is refused with a plain
// message the AI (or the person) can act on.

export class PanelError extends Error {
  constructor(
    readonly code: PanelErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (code: PanelErrorCode, message: string): never => {
  throw new PanelError(code, message);
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/;
const ID = /^[A-Za-z0-9_-]{1,32}$/;
const SERVER = /^[A-Za-z0-9_-]{1,32}$/;
const TOOL = /^[A-Za-z0-9_.:-]{1,64}$/;
// A "$" first is how the renderer names a variable ($notes); the rest is plain.
const STATE_KEY = /^\$?[A-Za-z0-9_.-]{1,64}$/;
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ICONS = new Set<string>(PANEL_ICONS);
const KINDS = new Set<string>(PANEL_FUNCTION_KINDS);

const bytes = (text: string) => new TextEncoder().encode(text).length;

// ------------------------------------------------------------------ checks

function text(value: unknown, what: string, max: number, min = 1): string {
  if (typeof value !== "string") return fail("bad_request", `${what} must be text.`);
  const t = value.trim();
  if (t.length < min || t.length > max || CONTROL.test(t)) return fail("bad_request", `${what} must be ${min === 0 ? "up to" : `${min} to`} ${max} characters, without control or invisible characters.`);
  return t;
}

export function uuid(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID.test(value)) return fail("bad_request", `${what} isn't valid.`);
  return value.toLowerCase();
}

export const validName = (value: unknown) => text(value, "A panel name", L.nameChars);

export function icon(value: unknown): PanelMeta["icon"] {
  if (typeof value !== "string" || !ICONS.has(value)) return fail("bad_request", "That icon isn't one Nido has.");
  return value as PanelMeta["icon"];
}

function ident(value: unknown, what: string): string {
  if (typeof value !== "string" || !ID.test(value)) return fail("bad_request", `${what} must be 1 to 32 letters, digits, "-" or "_".`);
  return value;
}

/** A source's fixed arguments: plain data of limited size. */
function args(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  const plain = typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  if (!plain) return fail("bad_request", "A source's arguments must be a set of named values.");
  const json = JSON.stringify(value);
  if (json.length > L.argChars || /"(__proto__|constructor|prototype)"\s*:/.test(json) || json.includes("\\u0000")) return fail("bad_request", `A source's arguments must be plain data under ${L.argChars} characters.`);
  return JSON.parse(json) as Record<string, unknown>;
}

export function sources(value: unknown): PanelSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > L.sources) return fail("bad_request", `A panel reads from at most ${L.sources} sources.`);
  const seen = new Set<string>();
  return value.map((raw) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const id = ident(s.id, "A source id");
    if (seen.has(id)) return fail("bad_request", `Source "${id}" appears twice.`);
    seen.add(id);
    if (typeof s.server !== "string" || !SERVER.test(s.server)) return fail("bad_request", "A source needs the name of one of your connected servers.");
    if (typeof s.tool !== "string" || !TOOL.test(s.tool)) return fail("bad_request", "A source needs the name of one of that server's tools.");
    if (!isReadTool(s.tool)) return fail("bad_request", `"${s.tool}" doesn't look like a read-only tool. Panels can only read.`);
    return { id, label: text(s.label, "A source label", L.labelChars), server: s.server, tool: s.tool, purpose: text(s.purpose, "A source purpose", L.descChars), args: args(s.args) };
  });
}

export function functions(value: unknown): PanelFunction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > L.functions) return fail("bad_request", `A panel has at most ${L.functions} functions.`);
  const seen = new Set<string>();
  return value.map((raw) => {
    const f = (raw ?? {}) as Record<string, unknown>;
    const id = ident(f.id, "A function id");
    if (seen.has(id)) return fail("bad_request", `Function "${id}" appears twice.`);
    seen.add(id);
    if (typeof f.kind !== "string" || !KINDS.has(f.kind)) return fail("bad_request", "That kind of function isn't one Nido has.");
    return { id, label: text(f.label, "A function label", L.labelChars), kind: f.kind as PanelFunction["kind"], description: text(f.description, "A function description", L.descChars) };
  });
}

function view(value: unknown): string {
  if (typeof value !== "string" || value.includes("\u0000")) return fail("bad_request", "The wireframe must be text.");
  if (value.trim() === "") return fail("bad_request", "The wireframe is empty.");
  if (bytes(value) > L.viewBytes) return fail("too_big", `The wireframe is over ${Math.round(L.viewBytes / 1000)} KB.`);
  if (!viewIsAllowed(value)) return fail("bad_request", "A wireframe can't ask for tool calls of its own. Data comes from the panel's sources.");
  return value;
}

/** A draft as the app accepts it: every field checked, nothing extra kept. */
export function checkDraft(raw: unknown): PanelDraft {
  const d = (raw ?? {}) as Record<string, unknown>;
  return { name: validName(d.name), icon: icon(d.icon), view: view(d.view), sources: sources(d.sources), functions: functions(d.functions) };
}

/** What a panel saves for itself: an object of named values, plain data only, of limited size, depth and number of keys. */
export function checkState(raw: unknown): Record<string, unknown> {
  const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  if (!isPlain(raw)) return fail("bad_request", "Saved data must be a set of named values.");
  const keys = Object.keys(raw);
  if (keys.length > L.stateKeys) return fail("too_big", `A panel can save at most ${L.stateKeys} named values.`);
  const walk = (v: unknown, depth: number): void => {
    if (depth > L.stateDepth) fail("bad_request", "Saved data is nested too deeply.");
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) fail("bad_request", "Saved numbers must be finite.");
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, depth + 1));
      return;
    }
    if (isPlain(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (BAD_KEYS.has(k)) fail("bad_request", "Saved data uses a name that isn't allowed.");
        walk(x, depth + 1);
      }
      return;
    }
    fail("bad_request", "Saved data can only hold text, numbers, true/false, lists and named values.");
  };
  for (const k of keys) {
    if (!STATE_KEY.test(k) || BAD_KEYS.has(k)) fail("bad_request", "A saved value's name must be 1 to 64 letters, digits, '.', '-' or '_'.");
    walk(raw[k], 1);
  }
  if (bytes(JSON.stringify(raw)) > L.stateBytes) return fail("too_big", `A panel can save at most ${Math.round(L.stateBytes / 1_000_000)} MB.`);
  return raw;
}

