// Custom panels: tabs in the Files card that the AI builds for one person, drawn from a generative UI spec (no AI code runs).
// A panel lives only on that person's desktop app (see desktop/src/panels-store.ts); the chat server stores none of it.

export const PANEL_LIMITS = {
  /** Panels per person per project, characters in a name. */
  perProject: 12,
  nameChars: 40,
  /** The wireframe (gen UI spec) in bytes, and what a panel saves for itself (ticks, notes, inputs) in bytes. */
  viewBytes: 100_000,
  stateBytes: 1_000_000,
  /** Keys in the saved state, and how deep a saved value may nest. */
  stateKeys: 200,
  stateDepth: 6,
  /** Data sources and functions a panel declares, and the length of their labels and descriptions. */
  sources: 8,
  functions: 16,
  labelChars: 80,
  descChars: 300,
  /** A source's fixed arguments as JSON, the answer of one read that a panel keeps, and how deep a path into it may go. */
  argChars: 2_000,
  resultChars: 50_000,
  pathParts: 8,
  /** Characters in one Notes box. */
  notesChars: 20_000,
} as const;

/** The icons a panel can wear. Nido draws them; a name outside this list is refused. */
export const PANEL_ICONS = ["panel", "list", "chart", "table", "note", "calendar", "star", "bolt", "globe", "code"] as const;
export type PanelIcon = (typeof PANEL_ICONS)[number];

/**
 * Where a panel's numbers come from: one read-only tool of one of the person's own connected services (MCP). The panel
 * names it; Nido checks it against its allowlist before anything is called, and the person sees it on Review.
 */
export type PanelSource = {
  /** Referenced by the spec. */
  id: string;
  /** What the person sees ("Open PRs"). */
  label: string;
  /** The name of the person's MCP server, and one of its tools. */
  server: string;
  tool: string;
  /** What it reads, in words ("List pull requests"). */
  purpose: string;
  /** Fixed arguments for the read (`{ "state": "open" }`): plain data, at most PANEL_LIMITS.argChars as JSON. */
  args: Record<string, unknown>;
};

/** What a panel can do besides show data. A button never changes anything outside Nido: "draft" only fills the chat box. */
export const PANEL_FUNCTION_KINDS = ["checklist", "notes", "input", "draft", "refresh"] as const;
export type PanelFunctionKind = (typeof PANEL_FUNCTION_KINDS)[number];
export type PanelFunction = { id: string; label: string; kind: PanelFunctionKind; description: string };

/** The tabs Nido ships that a custom panel may stand in for: the AI edits them by making a panel that replaces them, which the person can switch back. */
export const PANEL_REPLACES = ["vercel", "supabase"] as const;
export type PanelReplaces = (typeof PANEL_REPLACES)[number];
export const PANEL_REPLACES_LABEL: Record<PanelReplaces, string> = { vercel: "Vercel", supabase: "Supabase" };

export type PanelMeta = {
  id: string;
  name: string;
  icon: PanelIcon;
  /** 1 for the first version, +1 for every change. */
  rev: number;
  createdAt: number;
  updatedAt: number;
  sources: PanelSource[];
  functions: PanelFunction[];
  /** This panel stands in for one of Nido's own tabs: that tab is hidden while the panel exists. */
  replaces?: PanelReplaces;
};

/** What the AI (through a draft the person approves) hands over: everything except the bookkeeping. */
export type PanelDraft = {
  name: string;
  icon: PanelIcon;
  /** The gen UI spec, as text. */
  view: string;
  sources: PanelSource[];
  functions: PanelFunction[];
  replaces?: PanelReplaces;
};

export type PanelListItem = PanelMeta | { id: string; broken: true };

/** Everything the page needs to draw one panel. `hasPrev`: "Undo last change" has something to go back to. */
export type PanelFull = { meta: PanelMeta; view: string; state: Record<string, unknown>; hasPrev: boolean };

export type PanelErrorCode = "bad_request" | "not_found" | "too_many" | "too_big" | "name_taken" | "no_prev" | "broken" | "io";

// ------------------------------------------------------------------ reading a source

/** Why a source has nothing to show yet. Each is something the person can do, shown as a calm card, never as an error. */
export const SOURCE_NEEDS = ["setup", "signin", "retry", "busy", "unavailable"] as const;
/** setup: the service isn't added (or is off). signin: it needs the person's sign-in. retry: it didn't answer. busy: too many reads. unavailable: it has no such read any more. */
export type SourceNeed = (typeof SOURCE_NEEDS)[number];
export type SourceRead = { ok: true; text: string; truncated: boolean } | { ok: false; need: SourceNeed; server: string };

const READ_VERBS = /^(list|get|read|search|find|describe|show|view|count|fetch|query|lookup|check)([_.:-]|$)/i;
// A name that says it changes something is never a read, whatever it starts with ("get_or_create_...", "list_and_delete_...").
const WRITE_WORDS = /(^|[_.:-])(create|add|insert|update|upsert|edit|set|put|post|patch|write|delete|remove|drop|destroy|clear|reset|run|exec|execute|apply|deploy|merge|push|send|publish|promote|rollback|redeploy|assign|invite|grant|revoke|transfer|buy|pay|cancel|pause|migrate|rename|approve|reject|reopen|trigger|invoke|kill|restart|enable|disable|upload|login|logout|subscribe|unsubscribe)([_.:-]|$)/i;

/**
 * Whether a tool's name says it only reads. This is Nido's allowlist for panel data: a name must start with a reading word and
 * must not contain a changing word. It cannot catch a tool that lies about itself; it keeps the AI from naming `delete_*`
 * or `execute_sql` as a data source, and the person sees every source on Review.
 */
export function isReadTool(name: unknown): boolean {
  return typeof name === "string" && name.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(name) && READ_VERBS.test(name) && !WRITE_WORDS.test(name);
}

const PART = /^[A-Za-z0-9_]{1,40}$/;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/**
 * A tiny path into what a source returned: `rows`, `data.items[0].title`, `items.length`. Letters, digits and "_" in names, [n]
 * for a list position, `length` (and `count`) for the size of a list or text. Nothing is run. Anything else, or a missing
 * value, gives undefined. "" is the whole value.
 */
export function pickPath(value: unknown, path: string): unknown {
  if (typeof path !== "string" || path.length > 200) return undefined;
  if (path.trim() === "") return value;
  const parts = path.trim().replace(/\[(\d{1,6})\]/g, ".$1").replace(/^\./, "").split(".");
  if (parts.length > PANEL_LIMITS.pathParts) return undefined;
  let cur: unknown = value;
  for (const part of parts) {
    if (!/^\d{1,6}$/.test(part) && (!PART.test(part) || FORBIDDEN.has(part))) return undefined;
    if (Array.isArray(cur)) {
      if (/^\d+$/.test(part)) cur = cur[Number(part)];
      else if (part === "length" || part === "count") cur = cur.length;
      else return undefined;
    } else if (typeof cur === "string" && (part === "length" || part === "count")) {
      cur = cur.length;
    } else if (typeof cur === "object" && cur !== null && Object.hasOwn(cur, part)) {
      cur = (cur as Record<string, unknown>)[part];
    } else return undefined;
  }
  return cur;
}

/** What a read answered with, as data: JSON when it parses (the usual case), else the text itself. Never throws. */
export function readValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A wireframe may not ask for live tool calls or changes of its own: data comes only from the panel's declared sources. */
export const viewIsAllowed = (view: string): boolean => !/\b(Query|Mutation)\s*\(/.test(view);

// ------------------------------------------------------------------ what the AI proposed, waiting for the person

export type PanelShape = { name: string; icon: PanelIcon; view: string; sources: PanelSource[]; functions: PanelFunction[]; replaces?: PanelReplaces };
export type DraftKind = "new" | "update" | "delete";
/** What the page sees of a proposal, to draw its card and the review. The app keeps the proposal itself; a click names only its id. */
export type DraftView = PanelShape & {
  id: string;
  kind: DraftKind;
  projectId: string;
  /** update and delete: the panel it is about. */
  panelId?: string;
  /** update: what the panel is now, for the before and after. delete: the panel as it is. */
  before?: PanelShape & { rev: number };
  createdAt: number;
};
