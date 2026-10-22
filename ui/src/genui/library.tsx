import "./no-devtools.ts";
import { action, createLibrary, defineAction, defineComponent, FormNameContext, reactive, useFormName, useStateField, useTriggerAction } from "@openuidev/react-lang";
import { Check, Circle } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import { z } from "zod/v4";

/**
 * The pieces the AI may build an answer's visuals from (OpenUI Lang). The model only picks pieces and fills in their
 * values: it never writes HTML, styles or scripts, and every piece is drawn by the app with its own styles.
 * Clicks never act on their own: buttons, options and forms put a message in the composer, to send or change.
 * The server's prompt is built from this library's spec (shared/src/genui-spec.json); `npm run genui:spec -w ui` writes it.
 */

/** Generous caps, so a runaway answer can't build a page that freezes the chat. */
const MAX_ROWS = 200;
const MAX_BARS = 40;
const MAX_ITEMS = 30;
const ICON_SM = 14;
const STROKE = 1.75;

/** How text is drawn: the chat passes its own safe Markdown. Plain text by default (also keeps this file free of app imports for the spec script). */
export const GenTextContext = createContext<(text: string) => ReactNode>((text) => <p>{text}</p>);

function RichText({ text }: { text: string }) {
  return <>{useContext(GenTextContext)(text)}</>;
}

const Cell = z.union([z.string(), z.number()]);

/** The address a button's action opens, if any, so hovering shows where it goes (the label could say anything). */
function linkOf(plan: unknown): string | undefined {
  const steps = (plan as { steps?: { type?: string; url?: unknown }[] } | undefined)?.steps;
  const url = steps?.find((s) => s.type === "open_url")?.url;
  return typeof url === "string" ? url : undefined;
}

const Text = defineComponent({
  name: "Text",
  description: "A paragraph of text. Markdown inline formatting (bold, italics, code, links) works.",
  props: z.object({ text: z.string(), tone: z.enum(["default", "muted"]).optional() }),
  component: ({ props }) => (
    <div className={`gen-text ${props.tone === "muted" ? "muted" : ""}`}>
      <RichText text={props.text} />
    </div>
  ),
});

const Stat = defineComponent({
  name: "Stat",
  description: "One key number with its label, and an optional short note such as a change or a date.",
  props: z.object({ label: z.string(), value: Cell, note: z.string().optional() }),
  component: ({ props }) => (
    <div className="gen-stat">
      <div className="gen-stat-label">{props.label}</div>
      <div className="gen-stat-value">{String(props.value)}</div>
      {props.note && <div className="gen-stat-note">{props.note}</div>}
    </div>
  ),
});

const Table = defineComponent({
  name: "Table",
  description: "A table: column headers, then rows of cells in the same order.",
  props: z.object({ columns: z.array(z.string()), rows: z.array(z.array(Cell)) }),
  component: ({ props }) => (
    <div className="gen-table-wrap">
      <table className="gen-table">
        <thead>
          <tr>
            {props.columns.map((c, i) => (
              <th key={i}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(props.rows ?? []).slice(0, MAX_ROWS).map((row, r) => (
            <tr key={r}>
              {props.columns.map((_, c) => (
                <td key={c} className={typeof row?.[c] === "number" ? "num" : ""}>
                  {row?.[c] === undefined ? "" : String(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
});

const Series = defineComponent({
  name: "Series",
  description: "One named set of numbers for a BarChart, one number per label.",
  props: z.object({ name: z.string(), values: z.array(z.number()) }),
  component: () => null, // drawn by BarChart
});

const BarChart = defineComponent({
  name: "BarChart",
  description: "Bars to compare numbers across labels. Several Series show side by side.",
  props: z.object({ labels: z.array(z.string()), series: z.array(Series.ref), unit: z.string().optional() }),
  component: ({ props }) => {
    const labels = props.labels.slice(0, MAX_BARS);
    const series = (props.series ?? []).map((s) => (s as unknown as { props: { name: string; values: number[] } }).props).filter(Boolean).slice(0, 6);
    const max = Math.max(0, ...series.flatMap((s) => (s.values ?? []).map((v) => (Number.isFinite(v) ? v : 0))));
    const fmt = (v: number) => `${v.toLocaleString()}${props.unit ? ` ${props.unit}` : ""}`;
    return (
      <figure className="gen-chart">
        {series.length > 1 && (
          <figcaption className="gen-legend">
            {series.map((s, i) => (
              <span key={i}>
                <i className={`gen-swatch s${i}`} aria-hidden />
                {s.name}
              </span>
            ))}
          </figcaption>
        )}
        <div className="gen-bars" role="list">
          {labels.map((label, l) => (
            <div key={l} className="gen-bar-group" role="listitem" aria-label={`${label}: ${series.map((s) => `${series.length > 1 ? `${s.name} ` : ""}${fmt(s.values?.[l] ?? 0)}`).join(", ")}`}>
              <div className="gen-bar-stack">
                {series.map((s, i) => {
                  const v = Number.isFinite(s.values?.[l]) ? Math.max(0, s.values[l]!) : 0;
                  return <div key={i} className={`gen-bar s${i}`} style={{ height: `${max ? (v / max) * 100 : 0}%` }} title={`${series.length > 1 ? `${s.name}: ` : ""}${fmt(s.values?.[l] ?? 0)}`} />;
                })}
              </div>
              <div className="gen-bar-label">{label}</div>
            </div>
          ))}
        </div>
      </figure>
    );
  },
});

const Task = defineComponent({
  name: "Task",
  description: "One step or to-do, with who owns it (a person's name) and whether it is done.",
  props: z.object({ text: z.string(), owner: z.string().optional(), done: z.boolean().optional() }),
  component: ({ props }) => (
    <li className={props.done ? "done" : ""}>
      {props.done ? <Check size={ICON_SM} strokeWidth={STROKE} aria-label="Done" /> : <Circle size={ICON_SM} strokeWidth={STROKE} aria-label="To do" />}
      <span className="gen-task-text">{props.text}</span>
      {props.owner && <span className="chip">{props.owner}</span>}
    </li>
  ),
});

const Checklist = defineComponent({
  name: "Checklist",
  description: "A plan or list of next steps, each a Task.",
  props: z.object({ items: z.array(Task.ref), title: z.string().optional() }),
  component: ({ props, renderNode }) => (
    <div className="gen-checklist">
      {props.title && <div className="gen-title">{props.title}</div>}
      <ul>{renderNode((props.items ?? []).slice(0, MAX_ITEMS))}</ul>
    </div>
  ),
});

const Callout = defineComponent({
  name: "Callout",
  description: "A highlighted note: a warning, a tip, a success or a risk.",
  props: z.object({ tone: z.enum(["info", "success", "warning", "danger"]), title: z.string(), text: z.string().optional() }),
  component: ({ props }) => (
    <div className={`gen-callout ${props.tone}`} role={props.tone === "danger" || props.tone === "warning" ? "alert" : undefined}>
      <div className="gen-title">{props.title}</div>
      {props.text && <RichText text={props.text} />}
    </div>
  ),
});

const Option = defineComponent({
  name: "Option",
  description: "One choice the reader can pick, with a short explanation. Picking it drafts a reply with its label, or with the action's message.",
  props: z.object({ label: z.string(), detail: z.string().optional(), action: action().optional() }),
  component: ({ props }) => {
    const trigger = useTriggerAction();
    return (
      <button type="button" className="gen-option" title={linkOf(props.action)} onClick={() => void trigger(props.label, undefined, props.action)}>
        <span className="gen-option-label">{props.label}</span>
        {props.detail && <span className="gen-option-detail">{props.detail}</span>}
      </button>
    );
  },
});

const Choice = defineComponent({
  name: "Choice",
  description: "A question with options to pick from, when the answer needs a decision from the people in the chat.",
  props: z.object({ question: z.string(), options: z.array(Option.ref) }),
  component: ({ props, renderNode }) => (
    <div className="gen-choice">
      <div className="gen-title">{props.question}</div>
      <div className="gen-options">{renderNode((props.options ?? []).slice(0, 8))}</div>
    </div>
  ),
});

const Button = defineComponent({
  name: "Button",
  description: "A button. Without an action, clicking drafts a reply with its label.",
  props: z.object({ label: z.string(), action: action().optional(), variant: z.enum(["primary", "secondary"]).optional() }),
  component: ({ props }) => {
    const trigger = useTriggerAction();
    const form = useFormName();
    return (
      <button type="button" className={`btn sm ${props.variant === "primary" ? "primary" : ""}`} title={linkOf(props.action)} onClick={() => void trigger(props.label, form, props.action)}>
        {props.label}
      </button>
    );
  },
});

const Buttons = defineComponent({
  name: "Buttons",
  description: "A row of buttons, such as follow-up suggestions.",
  props: z.object({ buttons: z.array(Button.ref) }),
  component: ({ props, renderNode }) => <div className="gen-buttons">{renderNode((props.buttons ?? []).slice(0, 8))}</div>,
});

/** What a field shows: text as typed, a number as a number, nothing for anything else. */
const shown = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

const Input = defineComponent({
  name: "Input",
  description:
    "A text or number field: in a Form (`name` is the field's key in the reply), or on its own bound to a $variable as `value` so other blocks can compute from it. A \"number\" field stores a number.",
  props: z.object({
    name: z.string(),
    label: z.string(),
    value: reactive(z.union([z.string(), z.number()]).optional()),
    placeholder: z.string().optional(),
    type: z.enum(["text", "number"]).optional(),
    multiline: z.boolean().optional(),
  }),
  component: ({ props }) => {
    const field = useStateField(props.name, props.value);
    const value = shown(field.value);
    const id = `gen-${useFormName() ?? "form"}-${props.name}`;
    if (props.type === "number") {
      return (
        <label className="gen-field" htmlFor={id}>
          <span>{props.label}</span>
          <input
            id={id}
            className="input"
            type="number"
            step="any"
            inputMode="decimal"
            value={value}
            placeholder={props.placeholder}
            onChange={(e) => field.setValue(e.target.value === "" || !Number.isFinite(e.target.valueAsNumber) ? "" : e.target.valueAsNumber)}
          />
        </label>
      );
    }
    return (
      <label className="gen-field" htmlFor={id}>
        <span>{props.label}</span>
        {props.multiline ? (
          <textarea id={id} className="input" rows={3} maxLength={2000} value={value} placeholder={props.placeholder} onChange={(e) => field.setValue(e.target.value)} />
        ) : (
          <input id={id} className="input" maxLength={500} value={value} placeholder={props.placeholder} onChange={(e) => field.setValue(e.target.value)} />
        )}
      </label>
    );
  },
});

const Select = defineComponent({
  name: "Select",
  description: "A dropdown with the choices as plain text: in a Form, or on its own bound to a $variable as `value`.",
  props: z.object({ name: z.string(), label: z.string(), options: z.array(z.string()), value: reactive(z.string().optional()) }),
  component: ({ props }) => {
    const field = useStateField(props.name, props.value);
    const value = shown(field.value);
    const id = `gen-${useFormName() ?? "form"}-${props.name}`;
    return (
      <label className="gen-field" htmlFor={id}>
        <span>{props.label}</span>
        <select id={id} className="input" value={value} onChange={(e) => field.setValue(e.target.value)}>
          <option value="">Choose…</option>
          {props.options.slice(0, 50).map((o, i) => (
            <option key={i} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    );
  },
});

const Form = defineComponent({
  name: "Form",
  description: "Questions for the reader to fill in. The submit button drafts a reply with the answers.",
  props: z.object({ name: z.string(), fields: z.array(z.union([Input.ref, Select.ref])), submitLabel: z.string().optional() }),
  component: ({ props, renderNode }) => {
    const trigger = useTriggerAction();
    return (
      <FormNameContext.Provider value={props.name}>
        <form
          className="gen-form"
          onSubmit={(e) => {
            e.preventDefault();
            void trigger(props.submitLabel || "Here are my answers", props.name);
          }}
        >
          {renderNode((props.fields ?? []).slice(0, 12))}
          <div className="gen-buttons">
            <button type="submit" className="btn sm primary">
              {props.submitLabel || "Send answers"}
            </button>
          </div>
        </form>
      </FormNameContext.Provider>
    );
  },
});

const contentBlocks = [Text, Stat, Table, BarChart, Checklist, Callout, Choice, Buttons, Form, Input, Select] as const;
const Content = z.union(contentBlocks.map((c) => c.ref) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);

const Card = defineComponent({
  name: "Card",
  description: "A titled box that groups related blocks, such as one option of several or one person's part.",
  props: z.object({ title: z.string(), children: z.array(Content), subtitle: z.string().optional() }),
  component: ({ props, renderNode }) => (
    <section className="gen-card">
      <header>
        <div className="gen-title">{props.title}</div>
        {props.subtitle && <div className="gen-subtitle">{props.subtitle}</div>}
      </header>
      <div className="gen-stack">{renderNode(props.children ?? [])}</div>
    </section>
  ),
});

const Stack = defineComponent({
  name: "Stack",
  description: "The top-level container. Blocks go one under the other, or side by side with direction \"row\" (they wrap on narrow screens).",
  props: z.object({ children: z.array(z.union([Card.ref, Content])), direction: z.enum(["column", "row"]).optional() }),
  component: ({ props, renderNode }) => <div className={`gen-stack ${props.direction === "row" ? "row" : ""}`}>{renderNode(props.children ?? [])}</div>,
});

/** Copies text for the reader, such as a command or a message to paste elsewhere. */
export const CopyText = defineAction({
  name: "CopyText",
  description: "Copies the text to the reader's clipboard",
  params: z.object({ text: z.string() }),
});

export const genLibrary = createLibrary({
  root: "Stack",
  components: [Stack, Card, ...contentBlocks, Series, Task, Option, Button],
  actions: [CopyText],
  componentGroups: [
    { name: "Layout", components: ["Stack", "Card"] },
    { name: "Showing information", components: ["Text", "Stat", "Table", "BarChart", "Series", "Checklist", "Task", "Callout"], notes: ["- Use Table for comparisons with several attributes, BarChart for comparing amounts, Stat for 1-4 key numbers (in a row Stack)."] },
    {
      name: "Asking the people in the chat",
      components: ["Choice", "Option", "Buttons", "Button", "Form", "Input", "Select"],
      notes: [
        "- A click only drafts a reply in the clicker's message box; they still send it. Write option labels and @ToAssistant messages as the reply the person would send, in their voice.",
        '- Calculators and converters work on their own, with no message sent: declare $variables, bind them to Input/Select as `value` (outside a Form), and show results with Text or Stat using arithmetic and @Round, e.g. $c = 20, Input("c", "Celsius", $c, "", "number"), Stat("Fahrenheit", @Round($c * 9 / 5 + 32, 1)). Results update as the person types.',
      ],
    },
  ],
});
