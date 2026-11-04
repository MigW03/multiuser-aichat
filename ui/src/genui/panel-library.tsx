import "./no-devtools.ts";
import { createLibrary, defineComponent, reactive, useStateField } from "@openuidev/react-lang";
import { PANEL_LIMITS, pickPath, type SourceNeed } from "@mc/shared";
import { createContext, useContext, type ReactNode } from "react";
import { z } from "zod/v4";
import { contentBlocks, CopyText, layout, pieces } from "./library.tsx";

/**
 * The pieces a custom panel is built from: everything chat answers can show, plus blocks that keep the person's ticks and notes
 * on their computer and blocks that show numbers read from one of the person's own connected services. As in chat, the model
 * only picks pieces and fills in values; the app draws them. Data text comes from other people's services: it is drawn as plain
 * text, never as Markdown or links, and never goes to the AI.
 * The prompt for panels is built from this library's spec (shared/src/panel-spec.json); `npm run genui:spec -w ui` writes it.
 */

const MAX_ROWS = 50;
const MAX_ITEMS = 50;
const CELL_CHARS = 200;

// ------------------------------------------------------------------ what the panel's sources say right now

export type SourceState = { label: string } & (
  | { status: "loading" }
  | { status: "ok"; value: unknown; truncated: boolean; /** The read failed after a good one: the last data is shown, greyed. */ stale?: boolean; at?: number }
  | { status: "need"; need: SourceNeed; server: string }
);
export type PanelData = {
  sources: Record<string, SourceState>;
  /** What the cards' buttons do. The panel's own code never sees any of this: it only names a source. */
  act: { fix: (need: SourceNeed, server: string) => void; askToFix: (text: string) => void };
};
export const PanelDataContext = createContext<PanelData>({ sources: {}, act: { fix: () => undefined, askToFix: () => undefined } });
const useData = () => useContext(PanelDataContext);

/** One value from a source as text for a cell: plain, cut, nothing for anything that isn't text, a number or a yes/no. */
export function cellText(v: unknown): string {
  if (typeof v === "string") return v.length > CELL_CHARS ? `${v.slice(0, CELL_CHARS)}…` : v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  return "";
}

// ------------------------------------------------------------------ cards for what the person has to do

const NEED_TEXT: Record<SourceNeed, { title: (server: string) => string; text: (server: string, label: string) => string; action: string }> = {
  setup: { title: (s) => `Set up ${s}`, text: (s) => `This panel reads from ${s}. You haven't added it yet.`, action: "Set up" },
  signin: { title: (s) => `Sign in to ${s}`, text: (s, l) => `${s} needs your sign-in to show ${l}.`, action: "Sign in" },
  retry: { title: () => "Couldn't load this yet", text: (s) => `${s} didn't answer.`, action: "Try again" },
  busy: { title: () => "Busy right now", text: () => "Too many reads at once.", action: "Try again" },
  unavailable: { title: (s) => `${s} can't give this`, text: (s, l) => `${s} no longer offers what ${l} reads.`, action: "Ask AI to fix" },
};

/** A calm card, never red: what is missing, and one button. */
export function NeedCard({ need, server, label }: { need: SourceNeed; server: string; label: string }) {
  const { act } = useData();
  const t = NEED_TEXT[need];
  return (
    <div className="gen-need" role="status">
      <div className="gen-title">{t.title(server)}</div>
      <div className="gen-need-text">{t.text(server, label)}</div>
      <button type="button" className="btn sm primary" onClick={() => (need === "unavailable" ? act.askToFix(`The "${label}" block of this panel can't be read from ${server} any more. Please fix the panel.`) : act.fix(need, server))}>
        {t.action}
      </button>
    </div>
  );
}

/** A block that names a source the panel doesn't have: only that block says so. */
function Undrawn({ what }: { what: string }) {
  const { act } = useData();
  return (
    <div className="gen-need" role="status">
      <div className="gen-title">This part couldn't be drawn.</div>
      <button type="button" className="btn sm" onClick={() => act.askToFix(`In this panel, the block "${what.slice(0, 80)}" couldn't be drawn. Please fix the panel.`)}>
        Ask AI to fix
      </button>
    </div>
  );
}

/** What a data block needs: the source's state, or the card saying why there is none. */
function Source({ id, children }: { id: string; children: (value: unknown, stale: boolean) => ReactNode }) {
  const s = useData().sources[id];
  if (!s) return <Undrawn what={id} />;
  if (s.status === "need") return <NeedCard need={s.need} server={s.server} label={s.label} />;
  if (s.status === "loading") return <div className="gen-loading">Loading…</div>;
  return <>{children(s.value, s.stale === true)}</>;
}

// ------------------------------------------------------------------ blocks that show a source

const SourceStat = defineComponent({
  name: "SourceStat",
  description: "One key number from a data source: `source` is a source's id, `path` picks the value in what it returned (`items.length` counts a list, `data.total` reads a field).",
  props: z.object({ label: z.string(), source: z.string(), path: z.string(), note: z.string().optional() }),
  component: ({ props }) => (
    <Source id={props.source}>
      {(value, stale) => (
        <div className={`gen-stat ${stale ? "stale" : ""}`}>
          <div className="gen-stat-label">{props.label}</div>
          <div className="gen-stat-value">{cellText(pickPath(value, props.path)) || "–"}</div>
          {props.note && <div className="gen-stat-note">{props.note}</div>}
        </div>
      )}
    </Source>
  ),
});

const Col = defineComponent({
  name: "Col",
  description: "One column of a SourceTable: its header, and the path to its value in each row.",
  props: z.object({ header: z.string(), path: z.string() }),
  component: () => null, // drawn by SourceTable
});

const SourceTable = defineComponent({
  name: "SourceTable",
  description: "A table of the rows a data source returned. `rows` is the path to the list in what it returned (\"\" when the answer is the list itself); each Col reads one value from a row.",
  props: z.object({ source: z.string(), rows: z.string(), columns: z.array(Col.ref) }),
  component: ({ props }) => {
    const cols = (props.columns ?? []).map((c) => (c as unknown as { props: { header: string; path: string } }).props).filter(Boolean).slice(0, 8);
    return (
      <Source id={props.source}>
        {(value, stale) => {
          const rows = pickPath(value, props.rows);
          const list = Array.isArray(rows) ? rows.slice(0, MAX_ROWS) : [];
          return (
            <div className={`gen-table-wrap ${stale ? "stale" : ""}`}>
              {list.length === 0 ? (
                <div className="gen-subtitle">Nothing to show.</div>
              ) : (
                <table className="gen-table">
                  <thead>
                    <tr>
                      {cols.map((c, i) => (
                        <th key={i}>{c.header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((row, r) => (
                      <tr key={r}>
                        {cols.map((c, i) => {
                          const v = pickPath(row, c.path);
                          return (
                            <td key={i} className={typeof v === "number" ? "num" : ""}>
                              {cellText(v)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        }}
      </Source>
    );
  },
});

const SourceList = defineComponent({
  name: "SourceList",
  description: "A short list of the items a data source returned: `rows` is the path to the list, `title` the path to each item's text, `note` an optional path to a second line.",
  props: z.object({ source: z.string(), rows: z.string(), title: z.string(), note: z.string().optional(), heading: z.string().optional() }),
  component: ({ props }) => (
    <Source id={props.source}>
      {(value, stale) => {
        const rows = pickPath(value, props.rows);
        const list = Array.isArray(rows) ? rows.slice(0, MAX_ITEMS) : [];
        return (
          <div className={`gen-checklist ${stale ? "stale" : ""}`}>
            {props.heading && <div className="gen-title">{props.heading}</div>}
            {list.length === 0 ? (
              <div className="gen-subtitle">Nothing to show.</div>
            ) : (
              <ul className="gen-source-list">
                {list.map((row, i) => (
                  <li key={i}>
                    <span className="gen-task-text">{cellText(pickPath(row, props.title)) || "–"}</span>
                    {props.note && <span className="gen-subtitle">{cellText(pickPath(row, props.note))}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      }}
    </Source>
  ),
});

// ------------------------------------------------------------------ blocks that keep what the person types or ticks

const Check = defineComponent({
  name: "Check",
  description: "A tick box the person can tick; whether it is ticked is saved on their computer. `name` is its key.",
  props: z.object({ name: z.string(), label: z.string(), value: reactive(z.boolean().optional()) }),
  component: ({ props }) => {
    const field = useStateField(props.name, props.value);
    return (
      <label className="gen-check">
        <input type="checkbox" checked={field.value === true} onChange={(e) => field.setValue(e.target.checked)} />
        <span>{props.label}</span>
      </label>
    );
  },
});

const Notes = defineComponent({
  name: "Notes",
  description: "A box for the person's own notes; the text is saved on their computer. `name` is its key.",
  props: z.object({ name: z.string(), label: z.string(), placeholder: z.string().optional() }),
  component: ({ props }) => {
    const field = useStateField<string | undefined>(props.name, undefined);
    const id = `gen-notes-${props.name}`;
    return (
      <label className="gen-field" htmlFor={id}>
        <span>{props.label}</span>
        <textarea id={id} className="input" rows={5} maxLength={PANEL_LIMITS.notesChars} value={typeof field.value === "string" ? field.value : ""} placeholder={props.placeholder} onChange={(e) => field.setValue(e.target.value)} />
      </label>
    );
  },
});

const blocks = [...contentBlocks, SourceStat, SourceTable, SourceList, Check, Notes] as const;
const { Card, Stack } = layout(blocks);

export const panelLibrary = createLibrary({
  root: "Stack",
  components: [Stack, Card, ...blocks, Col, pieces.Series, pieces.Task, pieces.Option, pieces.Button],
  actions: [CopyText],
  componentGroups: [
    { name: "Layout", components: ["Stack", "Card"] },
    {
      name: "Showing information",
      components: ["Text", "Stat", "Table", "BarChart", "Series", "Checklist", "Task", "Callout"],
      notes: ["- These show what you write in them. For numbers that come from the person's own services use the data blocks below instead."],
    },
    {
      name: "Data from the person's connected services",
      components: ["SourceStat", "SourceTable", "Col", "SourceList"],
      notes: [
        "- Each data block names a source by its id. The panel declares its sources separately (id, server, read-only tool, fixed arguments); never invent a source, a server or a tool.",
        "- `path` is a plain path into what the source returned: names joined by dots, [n] for a list position, `length` for the size of a list. It is not code.",
        "- Write each path from what the tool really returns, as you saw it when you tried the tool. If you did not try it, keep the block simple.",
      ],
    },
    {
      name: "Things the person keeps",
      components: ["Check", "Notes", "Input", "Select"],
      notes: ["- Ticks, notes and field values are saved on the person's computer and are there when they come back. Give each a short, unique `name`."],
    },
    {
      name: "Drafting a message",
      components: ["Buttons", "Button"],
      notes: ["- A button only drafts a message in the person's chat box; they press Send. A panel never changes anything outside Nido by itself."],
    },
  ],
});
