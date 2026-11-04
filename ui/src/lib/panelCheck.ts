import type { PanelSource } from "@mc/shared";
import { createParser } from "@openuidev/react-lang";
import { panelLibrary } from "../genui/panel-library.tsx";

// What the person is shown about a proposal, worked out in the page from the proposal's own text. Nothing here runs the proposal.

const parser = createParser(panelLibrary.toJSONSchema(), panelLibrary.root);

/** Whether the app can draw this wireframe: it parses, and every piece it names is one Nido has. */
export function drawable(view: string): boolean {
  try {
    const r = parser.parse(view);
    return !!r.root && !r.meta.incomplete && r.meta.unresolved.length === 0 && r.meta.errors.every((e) => e.severity === "warning");
  } catch {
    return false;
  }
}

const KINDS: Record<string, string> = { Card: "Section", Stat: "Number", SourceStat: "Number", Table: "Table", SourceTable: "Table", BarChart: "Chart", Checklist: "List", SourceList: "List", Check: "Tick", Notes: "Notes", Input: "Field", Select: "Field", Button: "Button", Callout: "Note", Text: "Text" };

/** The parts of a wireframe as short lines ("Number · Open PRs"), in order, for a before and after. */
export function outline(view: string, sources: PanelSource[]): string[] {
  const label = (id: string) => sources.find((s) => s.id === id)?.label ?? id;
  const out: string[] = [];
  for (const m of view.matchAll(/\b([A-Z][A-Za-z]+)\(\s*"((?:[^"\\]|\\.){0,80})"(?:\s*,\s*"((?:[^"\\]|\\.){0,80})")?/g)) {
    const kind = KINDS[m[1]!];
    if (!kind) continue;
    const text = m[1] === "SourceTable" || m[1] === "SourceList" ? label(m[2]!) : m[1] === "Check" || m[1] === "Notes" || m[1] === "Input" || m[1] === "Select" ? (m[3] ?? m[2]!) : m[2]!;
    const line = `${kind} · ${text.replace(/\\(.)/g, "$1")}`;
    if (!out.includes(line)) out.push(line);
  }
  return out.slice(0, 40);
}

/** What an update adds that the person has not agreed to yet: new data it reads and new things it does. */
export function newInUpdate(before: { sources: PanelSource[]; functions: { id: string; label: string }[] }, now: { sources: PanelSource[]; functions: { id: string; label: string }[] }): string[] {
  const out: string[] = [];
  for (const s of now.sources) {
    const old = before.sources.find((b) => b.id === s.id);
    if (!old || old.server !== s.server || old.tool !== s.tool || JSON.stringify(old.args) !== JSON.stringify(s.args)) out.push(`New: reads ${s.label} from ${s.server} (${s.purpose})`);
  }
  for (const f of now.functions) if (!before.functions.some((b) => b.id === f.id)) out.push(`New: ${f.label}`);
  return out;
}

/** What the buttons in a wireframe really do, read from the program itself (not from the AI's description of it). */
export function buttonActions(view: string): string[] {
  const out: string[] = [];
  for (const m of view.matchAll(/@(OpenUrl|ToAssistant|CopyText)\(\s*("((?:[^"\\]|\\.){0,300})")?/g)) {
    const text = m[3] === undefined ? undefined : m[3].replace(/\\(.)/g, "$1");
    const what = m[1] === "OpenUrl" ? "Opens the link" : m[1] === "CopyText" ? "Copies" : "Drafts the message";
    const line = text === undefined ? `${what} (text worked out inside the panel)` : `${what}: ${text}`;
    if (!out.includes(line)) out.push(line);
  }
  return out.slice(0, 12);
}
