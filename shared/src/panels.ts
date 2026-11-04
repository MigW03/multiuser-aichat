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
};

/** What a panel can do besides show data. A button never changes anything outside Nido: "draft" only fills the chat box. */
export const PANEL_FUNCTION_KINDS = ["checklist", "notes", "input", "draft", "refresh"] as const;
export type PanelFunctionKind = (typeof PANEL_FUNCTION_KINDS)[number];
export type PanelFunction = { id: string; label: string; kind: PanelFunctionKind; description: string };

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
};

/** What the AI (through a draft the person approves) hands over: everything except the bookkeeping. */
export type PanelDraft = {
  name: string;
  icon: PanelIcon;
  /** The gen UI spec, as text. */
  view: string;
  sources: PanelSource[];
  functions: PanelFunction[];
};

export type PanelListItem = PanelMeta | { id: string; broken: true };

/** Everything the page needs to draw one panel. `hasPrev`: "Undo last change" has something to go back to. */
export type PanelFull = { meta: PanelMeta; view: string; state: Record<string, unknown>; hasPrev: boolean };

export type PanelErrorCode = "bad_request" | "not_found" | "too_many" | "too_big" | "name_taken" | "no_prev" | "broken" | "io";
