import { ChevronDown, ChevronRight, Frame as FrameIcon, Image as ImageIcon, LayoutGrid, Rows3, Columns3, Square, Type } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { boardBox, boardsOf, byNid, insertWithNewline, isBoard, isContainer, isTextLayer, layerName, layoutOf, nidOf, removeLayer, styleGet, styleSet, type Layout } from "../../lib/designModel.ts";
import { evalMath, sizeModeOf, sizeModeStyle, toHex, type SizeMode } from "../../lib/designEditor.ts";
import { STROKE } from "../kit.tsx";
import type { Commit } from "./Canvas.tsx";

// The panel on the right of the canvas. "Design" edits the selected layer's inline style (what the AI reads and code is
// built from); "Layers" is the tree of boards and layers. Every change is one commit: one undo step and one save.

export type Box = { left: number; top: number; width: number; height: number };

type Props = {
  root: HTMLElement;
  version: number;
  selection: string[];
  onSelect: (sel: string[]) => void;
  commit: Commit;
  readOnly: boolean;
  /** Where a layer is drawn, relative to its parent, in design px. */
  boxOf: (nid: string) => Box | null;
};

export function Inspector(p: Props) {
  const [tab, setTab] = useState<"design" | "layers">("design");
  return (
    <aside className="dz-insp dz-ui" aria-label="Inspector">
      <div className="notes-filter dz-insp-tabs" role="tablist" aria-label="Inspector">
        <button type="button" role="tab" aria-selected={tab === "design"} className={`notes-tab ${tab === "design" ? "on" : ""}`} onClick={() => setTab("design")}>
          Design
        </button>
        <button type="button" role="tab" aria-selected={tab === "layers"} className={`notes-tab ${tab === "layers" ? "on" : ""}`} onClick={() => setTab("layers")}>
          Layers
        </button>
      </div>
      <div className="dz-insp-body">{tab === "design" ? <DesignTab {...p} /> : <LayersTab {...p} />}</div>
    </aside>
  );
}

// ---------------------------------------------------------------- Design tab

/** styleSet cleans what it writes: a value typed in a field never brings in what a design may not hold (outside pictures, url() scripts). */
function setStyles(root: HTMLElement, nid: string, changes: Record<string, string | null>) {
  const el = byNid(root, nid);
  if (el) styleSet(el, changes);
}

const LAYOUTS: { v: Layout; label: string }[] = [
  { v: "flow", label: "None" },
  { v: "column", label: "Stack ↓" },
  { v: "row", label: "Stack →" },
  { v: "grid", label: "Grid" },
  { v: "free", label: "Free" },
];
const STACK_OFF = { display: null, "flex-direction": null, gap: null, "grid-template-columns": null, "align-items": null, "justify-content": null };
const SHADOWS: Record<string, string> = { none: "", small: "0 1px 3px rgba(0,0,0,0.12)", large: "0 8px 24px rgba(0,0,0,0.16)" };
const num = (v: string) => {
  const m = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(v.trim());
  return m ? Number(m[1]) : null;
};

function DesignTab({ root, selection, commit, readOnly, boxOf }: Props) {
  const el = selection.length === 1 ? byNid(root, selection[0]!) : null;
  if (selection.length > 1) return <p className="small muted dz-insp-note">{selection.length} layers selected. Ask AI (⌘L) to change them together, or pick one to see its settings.</p>;
  if (!el) {
    const boards = boardsOf(root);
    return (
      <p className="small muted dz-insp-note">
        {boards.length ? `${boards.length} board${boards.length === 1 ? "" : "s"}. ` : "No boards yet. Press F and click the canvas to add one. "}
        Click a layer to see its settings. Press ? for the shortcuts.
      </p>
    );
  }
  const nid = nidOf(el)!;
  const board = isBoard(el);
  const name = layerName(el);
  const parent = el.parentElement as HTMLElement | null;
  const parentLayout = parent && parent.hasAttribute("data-nid") ? layoutOf(parent) : "flow";
  const layout = layoutOf(el);
  const container = isContainer(el) && !isTextLayer(el);
  const text = isTextLayer(el) || (!container && (el.textContent ?? "").trim().length > 0);
  const st = el.style;
  const box = boxOf(nid);
  const set = (desc: string, changes: Record<string, string | null>) => commit(`${desc} of ${name}`, (r) => setStyles(r, nid, changes));
  const attr = (desc: string, k: string, v: string | null) =>
    commit(`${desc} of ${name}`, (r) => {
      const t = byNid(r, nid);
      if (!t) return;
      if (v === null) t.removeAttribute(k);
      else t.setAttribute(k, v);
    });

  const changeLayout = (next: Layout) => {
    commit(`set layout of ${name} to ${LAYOUTS.find((l) => l.v === next)?.label ?? next}`, (r) => {
      const t = byNid(r, nid);
      if (!t) return;
      const kids = [...t.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.hasAttribute("data-nid"));
      if (next === "free") {
        // Children keep their place: each gets the left/top it is drawn at now.
        for (const k of kids) {
          const b = boxOf(nidOf(k)!);
          styleSet(k, { position: "absolute", left: `${Math.round(b?.left ?? 0)}px`, top: `${Math.round(b?.top ?? 0)}px`, ...(b && !k.style.width ? { width: `${Math.round(b.width)}px` } : {}) });
        }
        t.setAttribute("data-layout", "free");
        styleSet(t, { ...STACK_OFF, position: "relative", ...(!t.style.height && !isBoard(t) ? { height: `${Math.round(boxOf(nid)?.height ?? 200)}px` } : {}) });
        return;
      }
      if (t.getAttribute("data-layout") === "free") {
        t.removeAttribute("data-layout");
        for (const k of kids) styleSet(k, { position: null, left: null, top: null });
        if (!isBoard(t)) styleSet(t, { position: null });
      }
      if (next === "flow") {
        styleSet(t, STACK_OFF);
        return;
      }
      if (next === "grid") {
        styleSet(t, { display: "grid", "flex-direction": null, ...(!t.style.gridTemplateColumns ? { "grid-template-columns": "repeat(2, minmax(0, 1fr))" } : {}) });
      } else styleSet(t, { display: "flex", "flex-direction": next, "grid-template-columns": null });
      if (!t.style.gap) styleSet(t, { gap: "8px" });
    });
  };

  const sizeRow = (axis: "w" | "h") => {
    const mode = sizeModeOf(st, axis, parentLayout);
    const cur = axis === "w" ? box?.width : box?.height;
    return (
      <div className="dz-row two">
        <NumField
          label={axis === "w" ? "W" : "H"}
          value={cur === undefined ? null : Math.round(cur)}
          disabled={readOnly}
          onCommit={(v) => set(`set ${axis === "w" ? "width" : "height"}`, sizeModeStyle("fixed", axis, parentLayout, v))}
        />
        <select
          className="dz-select"
          aria-label={axis === "w" ? "Width" : "Height"}
          value={mode}
          disabled={readOnly}
          onChange={(e) => set(`set ${axis === "w" ? "width" : "height"}`, sizeModeStyle(e.target.value as SizeMode, axis, parentLayout, cur ?? 100))}
        >
          <option value="hug">Hug</option>
          <option value="fill">Fill</option>
          <option value="fixed">Fixed</option>
        </select>
      </div>
    );
  };

  return (
    <div className="dz-fields">
      <label className="dz-name">
        <span className="sr-only">Layer name</span>
        <TextField
          value={board ? (el.getAttribute("data-board") ?? "") : (el.getAttribute("data-name") ?? "")}
          placeholder={name}
          disabled={readOnly}
          onCommit={(v) => (board ? attr("renamed board", "data-board", v.trim() || "Board") : attr("renamed", "data-name", v.trim() || null))}
        />
      </label>
      {parent && parent.hasAttribute("data-nid") && <div className="small muted dz-in">in {layerName(parent)}</div>}

      {board && (
        <Section title="Board">
          <div className="dz-row two">
            <NumField label="W" value={boardBox(el).w} disabled={readOnly} onCommit={(v) => attr("set width", "data-w", String(Math.max(40, Math.round(v))))} />
            <NumField label="H" value={boardBox(el).h ?? (box ? Math.round(box.height) : null)} disabled={readOnly} onCommit={(v) => attr("set height", "data-h", String(Math.max(40, Math.round(v))))} />
          </div>
          <div className="dz-row two">
            <NumField label="X" value={boardBox(el).x} disabled={readOnly} onCommit={(v) => attr("set x", "data-x", String(Math.round(v)))} />
            <NumField label="Y" value={boardBox(el).y} disabled={readOnly} onCommit={(v) => attr("set y", "data-y", String(Math.round(v)))} />
          </div>
        </Section>
      )}

      {container && (
        <Section title="Layout">
          <div className="dz-row">
            <span className="dz-label">Type</span>
            <select className="dz-select grow" aria-label="Layout" value={layout} disabled={readOnly} onChange={(e) => changeLayout(e.target.value as Layout)}>
              {LAYOUTS.map((l) => (
                <option key={l.v} value={l.v}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          {(layout === "row" || layout === "column" || layout === "grid") && (
            <>
              <div className="dz-row two">
                <NumField label="Gap" value={num(st.gap)} disabled={readOnly} onCommit={(v) => set("set gap", { gap: `${Math.max(0, v)}px` })} />
                {layout === "grid" && (
                  <NumField
                    label="Cols"
                    value={Number(/repeat\((\d+)/.exec(st.gridTemplateColumns)?.[1] ?? 0) || null}
                    disabled={readOnly}
                    onCommit={(v) => set("set columns", { "grid-template-columns": `repeat(${Math.min(12, Math.max(1, Math.round(v)))}, minmax(0, 1fr))` })}
                  />
                )}
              </div>
              <div className="dz-row">
                <span className="dz-label">Align</span>
                <select className="dz-select grow" aria-label="Align items" value={st.alignItems || "stretch"} disabled={readOnly} onChange={(e) => set("set alignment", { "align-items": e.target.value === "stretch" ? null : e.target.value })}>
                  <option value="stretch">Stretch</option>
                  <option value="flex-start">Start</option>
                  <option value="center">Center</option>
                  <option value="flex-end">End</option>
                </select>
              </div>
              {layout !== "grid" && (
                <div className="dz-row">
                  <span className="dz-label">Spread</span>
                  <select className="dz-select grow" aria-label="Justify content" value={st.justifyContent || "flex-start"} disabled={readOnly} onChange={(e) => set("set spacing", { "justify-content": e.target.value === "flex-start" ? null : e.target.value })}>
                    <option value="flex-start">Start</option>
                    <option value="center">Center</option>
                    <option value="flex-end">End</option>
                    <option value="space-between">Space between</option>
                  </select>
                </div>
              )}
            </>
          )}
          <div className="dz-row">
            <span className="dz-label">Padding</span>
            <TextField value={styleGet(el, "padding")} placeholder="0" disabled={readOnly} onCommit={(v) => set("set padding", { padding: paddingValue(v) })} />
          </div>
        </Section>
      )}

      {!board && (
        <Section title="Size">
          {sizeRow("w")}
          {sizeRow("h")}
          {st.position === "absolute" && (
            <div className="dz-row two">
              <NumField label="X" value={num(st.left) ?? (box ? Math.round(box.left) : null)} disabled={readOnly} onCommit={(v) => set("set x", { left: `${Math.round(v)}px` })} />
              <NumField label="Y" value={num(st.top) ?? (box ? Math.round(box.top) : null)} disabled={readOnly} onCommit={(v) => set("set y", { top: `${Math.round(v)}px` })} />
            </div>
          )}
        </Section>
      )}

      <Section title="Style">
        <ColorRow label="Fill" value={styleGet(el, "background") || styleGet(el, "background-color")} disabled={readOnly} onCommit={(v) => set("set fill", { background: v || null, "background-color": null })} />
        <div className="dz-row two">
          <NumField label="Radius" value={num(st.borderRadius)} disabled={readOnly} onCommit={(v) => set("set radius", { "border-radius": `${Math.max(0, v)}px` })} />
          <NumField label="Opacity" value={st.opacity ? Math.round(Number(st.opacity) * 100) : 100} disabled={readOnly} onCommit={(v) => set("set opacity", { opacity: v >= 100 ? null : String(Math.max(0, v) / 100) })} />
        </div>
        <div className="dz-row">
          <span className="dz-label">Border</span>
          <TextField value={styleGet(el, "border")} placeholder="1px solid #e5e5e5" disabled={readOnly} onCommit={(v) => set("set border", { border: v.trim() || null })} />
        </div>
        <div className="dz-row">
          <span className="dz-label">Shadow</span>
          <select
            className="dz-select grow"
            aria-label="Shadow"
            value={Object.entries(SHADOWS).find(([, v]) => v === st.boxShadow)?.[0] ?? (st.boxShadow ? "custom" : "none")}
            disabled={readOnly}
            onChange={(e) => e.target.value !== "custom" && set("set shadow", { "box-shadow": SHADOWS[e.target.value] || null })}
          >
            <option value="none">None</option>
            <option value="small">Small</option>
            <option value="large">Large</option>
            {st.boxShadow && !Object.values(SHADOWS).includes(st.boxShadow) && <option value="custom">Custom</option>}
          </select>
        </div>
      </Section>

      {(text || board || (container && (el.textContent ?? "").trim().length > 0)) && (
        <Section title="Text">
          <ColorRow label="Color" value={styleGet(el, "color")} disabled={readOnly} onCommit={(v) => set("set text color", { color: v || null })} />
          <div className="dz-row two">
            <NumField label="Size" value={num(st.fontSize)} disabled={readOnly} onCommit={(v) => set("set text size", { "font-size": `${Math.max(1, v)}px` })} />
            <select className="dz-select" aria-label="Weight" value={st.fontWeight || "400"} disabled={readOnly} onChange={(e) => set("set text weight", { "font-weight": e.target.value === "400" ? null : e.target.value })}>
              <option value="300">Light</option>
              <option value="400">Regular</option>
              <option value="500">Medium</option>
              <option value="600">Semibold</option>
              <option value="700">Bold</option>
            </select>
          </div>
          <div className="dz-row">
            <span className="dz-label">Align</span>
            <span className="segmented dz-seg" role="radiogroup" aria-label="Text align">
              {["left", "center", "right"].map((a) => (
                <button key={a} type="button" role="radio" aria-checked={(st.textAlign || "left") === a} disabled={readOnly} className={`seg ${(st.textAlign || "left") === a ? "on" : ""}`} onClick={() => set("set text align", { "text-align": a === "left" ? null : a })}>
                  {a[0]!.toUpperCase() + a.slice(1)}
                </button>
              ))}
            </span>
          </div>
        </Section>
      )}
    </div>
  );
}

/** "16" -> "16px", "8 16" -> "8px 16px"; other CSS as typed. */
function paddingValue(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  if (/^[\d.\s]+$/.test(t)) return t.split(/\s+/).slice(0, 4).map((n) => `${n}px`).join(" ");
  return t;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="dz-section">
      <h3 className="dz-section-title">{title}</h3>
      {children}
    </section>
  );
}

/** A text field that commits on Enter or when it loses focus, and shows the model's value again otherwise. */
function TextField({ value, placeholder, disabled, onCommit }: { value: string; placeholder?: string; disabled?: boolean; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const done = () => draft !== value && onCommit(draft);
  return (
    <input
      className="dz-input grow"
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={200}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          e.stopPropagation();
        }
      }}
    />
  );
}

/**
 * A number field like Figma's: type a number or arithmetic ("24+8"), arrows step 1 (Shift 10), and drag the label
 * sideways to scrub. Commits once per change.
 */
function NumField({ label, value, disabled, onCommit }: { label: string; value: number | null; disabled?: boolean; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const scrub = useRef<{ x: number; start: number } | null>(null);
  useEffect(() => setDraft(value === null ? "" : String(value)), [value]);
  const commitText = () => {
    const v = evalMath(draft);
    if (v === null || v === value) return setDraft(value === null ? "" : String(value));
    onCommit(v);
  };
  return (
    <label className="dz-num">
      <span
        className="dz-label scrub"
        onPointerDown={(e) => {
          if (disabled || value === null) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          scrub.current = { x: e.clientX, start: value };
        }}
        onPointerMove={(e) => {
          if (scrub.current) setDraft(String(Math.round(scrub.current.start + (e.clientX - scrub.current.x) * (e.shiftKey ? 10 : 1))));
        }}
        onPointerUp={(e) => {
          if (!scrub.current) return;
          const v = Math.round(scrub.current.start + (e.clientX - scrub.current.x) * (e.shiftKey ? 10 : 1));
          scrub.current = null;
          if (v !== value) onCommit(v);
        }}
      >
        {label}
      </span>
      <input
        className="dz-input"
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            setDraft(value === null ? "" : String(value));
            e.stopPropagation();
          } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && value !== null) {
            e.preventDefault();
            onCommit(value + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1));
          }
        }}
      />
    </label>
  );
}

function ColorRow({ label, value, disabled, onCommit }: { label: string; value: string; disabled?: boolean; onCommit: (v: string) => void }) {
  const hex = toHex(value);
  return (
    <div className="dz-row">
      <span className="dz-label">{label}</span>
      <input type="color" className="dz-color" aria-label={`${label} colour`} value={hex ?? "#ffffff"} disabled={disabled} onChange={(e) => onCommit(e.target.value)} />
      <TextField value={value} placeholder="none" disabled={disabled} onCommit={onCommit} />
    </div>
  );
}

// ---------------------------------------------------------------- Layers tab

function iconFor(el: Element): ReactNode {
  const s = { size: 13, strokeWidth: STROKE, "aria-hidden": true } as const;
  if (isBoard(el)) return <FrameIcon {...s} />;
  if (el.nodeName === "IMG") return <ImageIcon {...s} />;
  if (isTextLayer(el)) return <Type {...s} />;
  const l = el instanceof HTMLElement ? layoutOf(el) : "flow";
  if (l === "row") return <Columns3 {...s} />;
  if (l === "column") return <Rows3 {...s} />;
  if (l === "grid" || l === "free") return <LayoutGrid {...s} />;
  return <Square {...s} />;
}

function LayersTab({ root, version, selection, onSelect, commit, readOnly }: Props) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const dragging = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  // The selected layers' parents open, so the selection is always in view.
  useEffect(() => {
    let changed = false;
    const next = new Set(closed);
    for (const s of selection) for (let p = byNid(root, s)?.parentElement; p && p.hasAttribute("data-nid"); p = p.parentElement) if (next.delete(nidOf(p)!)) changed = true;
    if (changed) setClosed(next);
    list.current?.querySelector(`[data-row="${selection[0]}"]`)?.scrollIntoView({ block: "nearest" });
    // only when the selection changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  const rows = useMemo(() => {
    const out: { el: HTMLElement; depth: number; kids: boolean }[] = [];
    const walk = (el: HTMLElement, depth: number) => {
      const kids = [...el.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.hasAttribute("data-nid") && !isTextLayer(el));
      out.push({ el, depth, kids: kids.length > 0 });
      if (!closed.has(nidOf(el)!)) for (const k of kids) walk(k, depth + 1);
    };
    for (const b of boardsOf(root)) walk(b, 0);
    return out;
    // the tree changes with the model's version
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, version, closed]);

  const drop = (e: DragEvent, target: string) => {
    e.preventDefault();
    setOver(null);
    const moving = dragging.current;
    dragging.current = null;
    if (!moving || moving === target || readOnly) return;
    const t = byNid(root, target);
    const m = byNid(root, moving);
    if (!t || !m || isBoard(t) || m.contains(t)) return;
    commit(`moved ${layerName(m)} before ${layerName(t)}`, (r) => {
      const node = byNid(r, moving)!;
      const before = byNid(r, target)!;
      const parent = before.parentElement!;
      removeLayer(node);
      if (parent.getAttribute("data-layout") === "free") {
        styleSet(node, { position: "absolute", left: node.style.left || "0px", top: node.style.top || "0px" });
      } else styleSet(node, { position: null, left: null, top: null });
      insertWithNewline(parent, node, before);
    });
  };

  if (rows.length === 0) return <p className="small muted dz-insp-note">No layers yet.</p>;
  return (
    <div className="dz-layers" role="tree" aria-label="Layers" ref={list}>
      {rows.map(({ el, depth, kids }) => {
        const nid = nidOf(el)!;
        const open = !closed.has(nid);
        const board = isBoard(el);
        return (
          <div
            key={nid}
            data-row={nid}
            role="treeitem"
            aria-selected={selection.includes(nid)}
            aria-expanded={kids ? open : undefined}
            className={`dz-layer ${selection.includes(nid) ? "on" : ""} ${over === nid ? "over" : ""} ${board ? "board" : ""}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            draggable={!readOnly && !board && renaming !== nid}
            onDragStart={(e) => {
              dragging.current = nid;
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", nid);
            }}
            onDragOver={(e) => {
              if (!dragging.current || board) return;
              e.preventDefault();
              setOver(nid);
            }}
            onDragLeave={() => setOver((o) => (o === nid ? null : o))}
            onDrop={(e) => drop(e, nid)}
            onClick={(e) => onSelect(e.shiftKey ? (selection.includes(nid) ? selection.filter((s) => s !== nid) : [...selection, nid]) : [nid])}
            onDoubleClick={() => !readOnly && setRenaming(nid)}
          >
            <button
              type="button"
              className="dz-caret"
              tabIndex={-1}
              aria-hidden={!kids}
              style={{ visibility: kids ? "visible" : "hidden" }}
              onClick={(e) => {
                e.stopPropagation();
                setClosed((c) => {
                  const n = new Set(c);
                  if (n.has(nid)) n.delete(nid);
                  else n.add(nid);
                  return n;
                });
              }}
            >
              {open ? <ChevronDown size={12} strokeWidth={STROKE} /> : <ChevronRight size={12} strokeWidth={STROKE} />}
            </button>
            {iconFor(el)}
            {renaming === nid ? (
              <input
                className="dz-input grow"
                defaultValue={board ? (el.getAttribute("data-board") ?? "") : (el.getAttribute("data-name") ?? layerName(el))}
                autoFocus
                maxLength={60}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  setRenaming(null);
                  const v = e.target.value.trim();
                  if (v === layerName(el)) return;
                  commit(`renamed ${layerName(el)} to ${v || "(no name)"}`, (r) => {
                    const t = byNid(r, nid);
                    if (!t) return;
                    if (board) t.setAttribute("data-board", v || "Board");
                    else if (v) t.setAttribute("data-name", v);
                    else t.removeAttribute("data-name");
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setRenaming(null);
                  }
                }}
              />
            ) : (
              <span className="grow truncate">{layerName(el)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
