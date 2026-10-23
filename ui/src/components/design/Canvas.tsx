import { Copy, Hand, Minus, MousePointer2, Plus, Sparkles, Square, Trash2, Type, Frame as FrameIcon } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import {
  boardBox,
  boardHash,
  boardsOf,
  byNid,
  insertWithNewline,
  isBoard,
  isContainer,
  isTextLayer,
  layerName,
  nidOf,
  removeLayer,
  renumber,
  newNid,
  styleSet,
} from "../../lib/designModel.ts";
import { rect, SNAP_PX, union, type Guide, type Rect, type Targets } from "../../lib/designSnap.ts";
import { ICON_SM, STROKE } from "../kit.tsx";
import { chainAt, containerAt, drawnOf, drawWorld, dropSpot, frameOf, isAbsolute, layoutKind, pickInChain, px, SHADOW_CSS, targetsFor, toDesign, toScreen, type View } from "./canvasCore.ts";

// The design canvas: draws the design (in a shadow root, cleaned, no scripts) and lets people shape it like in Figma:
// click to select, drag with smart guides, drag inside stacks to reorder, resize with handles, double-click text to
// edit it, draw frames, boxes and text, and the keyboard for all of it. Every change goes through `commit`, which the
// design panel turns into one undo step and a save.

export type Tool = "move" | "frame" | "box" | "text" | "hand";
export type Commit = (desc: string, mutate: (root: HTMLElement) => void, select?: string[]) => boolean;

export type CanvasHandle = {
  fit: () => void;
  zoomTo: (z: number) => void;
  zoomToSelection: () => void;
  focus: () => void;
  /** Re-reads the drawn layers' places (after the inspector changed something). */
  refresh: () => void;
  /** Where a layer is drawn, relative to its parent, in design px. */
  boxOf: (nid: string) => { left: number; top: number; width: number; height: number } | null;
};

type Props = {
  root: HTMLElement;
  version: number;
  selection: string[];
  onSelect: (sel: string[]) => void;
  commit: Commit;
  readOnly: boolean;
  flash: string[];
  onAskAI: () => void;
  onBuild: (boards: string[]) => void;
  onUpdateCode: (boards: string[]) => void;
  onOpenCode: (path: string) => void;
  /** A board's code link: its file and whether the design changed since it was built. */
  codeOf: (board: HTMLElement) => { path: string; changed: boolean } | null;
  onToast: (text: string) => void;
  onShortcuts: () => void;
  /** Escape with nothing selected: back to the chat. */
  onExit: () => void;
};

type Ov = {
  sel: Rect[];
  hover: Rect | null;
  boards: { nid: string; name: string; r: Rect; code: { path: string; changed: boolean } | null }[];
  guides: Guide[];
  line: Rect | null;
  marquee: Rect | null;
  draw: Rect | null;
  size: string | null;
  flash: Rect[];
};
const EMPTY_OV: Ov = { sel: [], hover: null, boards: [], guides: [], line: null, marquee: null, draw: null, size: null, flash: [] };

type Gesture =
  | { kind: "press"; x: number; y: number; target: string; alt: boolean; shift: boolean }
  | { kind: "pan"; x: number; y: number; view: View }
  | { kind: "marquee"; x: number; y: number; base: string[] }
  | { kind: "boards"; x: number; y: number; items: { nid: string; frame: HTMLElement; bx: number; by: number }[]; targets: Targets }
  | { kind: "free"; x: number; y: number; items: { nid: string; el: HTMLElement; left: number; top: number }[]; targets: Targets }
  | { kind: "reorder"; x: number; y: number; nid: string; el: HTMLElement; drop: { parent: string; index: number; free?: { left: number; top: number } } | null }
  | { kind: "resize"; x: number; y: number; nid: string; handle: string; start: Rect; el: HTMLElement; board: boolean; targets: Targets; left: number | null; top: number | null }
  | { kind: "draw"; x: number; y: number; tool: Tool; container: string | null };

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
const modKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
/**
 * Where a dragged layer may land: a board, a stack, a free frame, or a frame that already holds layers. An empty box is
 * a sibling to drop beside, not a place to drop into (Figma's auto layout does the same).
 */
const canHold = (el: HTMLElement) => isBoard(el) || (isContainer(el) && !isTextLayer(el) && (layoutKind(el).layout !== "flow" || [...el.children].some((c) => c.hasAttribute("data-nid"))));

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas(p, ref) {
  const vpRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<View>({ x: 40, y: 60, z: 0.5 });
  const [view, setView] = useState<View>(viewRef.current);
  const [tool, setTool] = useState<Tool>("move");
  const [ov, setOv] = useState<Ov>(EMPTY_OV);
  const [hover, setHover] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [space, setSpace] = useState(false);
  const [alt, setAlt] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const fitted = useRef(false);
  const clip = useRef<string[]>([]);
  const props = useRef(p);
  props.current = p;

  // ---- drawing
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || shadowRef.current) return;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = SHADOW_CSS;
    const world = document.createElement("div");
    world.className = "world";
    shadow.append(style, world);
    shadowRef.current = shadow;
    worldRef.current = world;
  }, []);

  const applyView = useCallback((v: View) => {
    viewRef.current = v;
    if (worldRef.current) worldRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
    setView(v);
  }, []);

  const measure = useCallback(() => {
    const world = worldRef.current;
    const vp = vpRef.current?.getBoundingClientRect();
    if (!world || !vp) return;
    const v = viewRef.current;
    const rectOf = (nid: string): Rect | null => {
      const el = frameOf(world, nid) ?? drawnOf(world, nid);
      return el ? toDesign(el.getBoundingClientRect(), vp, v) : null;
    };
    const sel = props.current.selection.map(rectOf).filter((r): r is Rect => !!r).map((r) => toScreen(r, v));
    const h = hover && !props.current.selection.includes(hover) ? rectOf(hover) : null;
    const boards = boardsOf(props.current.root).flatMap((b) => {
      const nid = nidOf(b);
      const r = nid ? rectOf(nid) : null;
      return nid && r ? [{ nid, name: layerName(b), r: toScreen(r, v), code: props.current.codeOf(b) }] : [];
    });
    const flash = props.current.flash.map(rectOf).filter((r): r is Rect => !!r).map((r) => toScreen(r, v));
    setOv((o) => ({ ...o, sel, hover: h ? toScreen(h, v) : null, boards, flash }));
  }, [hover]);

  useLayoutEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    drawWorld(world, p.root);
    applyView(viewRef.current);
    if (!fitted.current && boardsOf(p.root).length) {
      fitted.current = true;
      fitAll();
    }
    if (editing) setEditing(null);
    measure();
    // fitAll and measure read refs; drawing depends on the model's version only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.root, p.version]);

  useLayoutEffect(measure, [measure, p.selection, view, p.flash]);
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp || typeof ResizeObserver === "undefined") return;
    const o = new ResizeObserver(() => measure());
    o.observe(vp);
    return () => o.disconnect();
  }, [measure]);

  // ---- view
  const fitRect = useCallback(
    (r: Rect | null) => {
      const vp = vpRef.current?.getBoundingClientRect();
      if (!vp || !r) return;
      const pad = 60;
      const z = clamp(Math.min((vp.width - pad * 2) / Math.max(1, r.x1 - r.x0), (vp.height - pad * 2) / Math.max(1, r.y1 - r.y0)), 0.05, 2);
      applyView({ z, x: (vp.width - (r.x1 - r.x0) * z) / 2 - r.x0 * z, y: (vp.height - (r.y1 - r.y0) * z) / 2 - r.y0 * z });
    },
    [applyView],
  );
  const allRect = (): Rect | null => {
    const bs = boardsOf(props.current.root).map((b) => {
      const box = boardBox(b);
      const frame = worldRef.current ? frameOf(worldRef.current, nidOf(b) ?? "") : null;
      return rect(box.x, box.y, box.w, frame?.offsetHeight ?? box.h ?? 600);
    });
    return bs.length ? bs.reduce(union) : null;
  };
  const fitAll = () => fitRect(allRect());
  const selRect = (): Rect | null => {
    const world = worldRef.current;
    const vp = vpRef.current?.getBoundingClientRect();
    if (!world || !vp) return null;
    const rs = props.current.selection.map((n) => frameOf(world, n) ?? drawnOf(world, n)).filter((e): e is HTMLElement => !!e).map((e) => toDesign(e.getBoundingClientRect(), vp, viewRef.current));
    return rs.length ? rs.reduce(union) : null;
  };
  const zoomAt = (z: number, cx: number, cy: number) => {
    const v = viewRef.current;
    const nz = clamp(z, 0.05, 8);
    applyView({ z: nz, x: cx - ((cx - v.x) / v.z) * nz, y: cy - ((cy - v.y) / v.z) * nz });
  };

  useImperativeHandle(ref, () => ({
    fit: fitAll,
    zoomTo: (z: number) => {
      const vp = vpRef.current?.getBoundingClientRect();
      if (vp) zoomAt(z, vp.width / 2, vp.height / 2);
    },
    zoomToSelection: () => fitRect(selRect()),
    focus: () => vpRef.current?.focus(),
    refresh: measure,
    boxOf: (nid: string) => {
      const world = worldRef.current;
      const el = world ? (frameOf(world, nid) ?? drawnOf(world, nid)) : null;
      return el ? { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight } : null;
    },
  }));

  // Zoom with pinch or Cmd/Ctrl + wheel, pan with the wheel. Not passive, so the page does not scroll or zoom.
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(viewRef.current.z * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else applyView({ ...viewRef.current, x: viewRef.current.x - e.deltaX, y: viewRef.current.y - e.deltaY });
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
    // zoomAt reads refs only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyView]);

  // ---- helpers
  const vpRect = () => vpRef.current!.getBoundingClientRect();
  const threshold = (e: { ctrlKey: boolean }) => (isMac && e.ctrlKey ? 0 : SNAP_PX / viewRef.current.z);
  const model = (nid: string) => byNid(props.current.root, nid);
  const select = (sel: string[]) => props.current.onSelect(sel);
  const guard = () => {
    if (props.current.readOnly) {
      props.current.onToast("The design can't be changed right now.");
      return false;
    }
    return true;
  };

  // ---- pointer
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button === 2) return;
    if ((e.target as HTMLElement).closest(".dz-ui")) return;
    setMenu(null);
    const shadow = shadowRef.current;
    if (!shadow || editing) {
      if (editing && !(e.target as HTMLElement).closest?.(".dz-host")) commitText();
      if (!shadow) return;
    }
    vpRef.current?.focus();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (e.button === 1 || tool === "hand" || space) {
      gesture.current = { kind: "pan", x: e.clientX, y: e.clientY, view: viewRef.current };
      return;
    }
    const chain = chainAt(shadow, e.clientX, e.clientY);
    if (tool !== "move") {
      const container = containerAt(shadow, props.current.root, e.clientX, e.clientY, new Set(), (el) => isContainer(el));
      gesture.current = { kind: "draw", x: e.clientX, y: e.clientY, tool, container };
      return;
    }
    if (chain.length === 0) {
      gesture.current = { kind: "marquee", x: e.clientX, y: e.clientY, base: e.shiftKey ? props.current.selection : [] };
      if (!e.shiftKey) select([]);
      return;
    }
    const target = modKey(e) ? chain.at(-1)! : pickInChain(chain, props.current.selection, props.current.root)!;
    if (e.shiftKey) {
      const sel = props.current.selection;
      select(sel.includes(target) ? sel.filter((s) => s !== target) : [...sel, target]);
      gesture.current = null;
      return;
    }
    if (!props.current.selection.includes(target)) select([target]);
    gesture.current = { kind: "press", x: e.clientX, y: e.clientY, target, alt: e.altKey, shift: false };
  };

  const startDrag = (g: Extract<Gesture, { kind: "press" }>, e: PointerEvent | RPointerEvent) => {
    const world = worldRef.current!;
    const vp = vpRect();
    const v = viewRef.current;
    if (!guard()) return null;
    const sel = props.current.selection.includes(g.target) ? props.current.selection : [g.target];
    const els = sel.map(model).filter((x): x is HTMLElement => !!x);
    if (els.length && els.every((x) => isBoard(x))) {
      if (g.alt) {
        // Alt-drag on frames, as in Figma: a copy of each stays where it was and the frames themselves move.
        props.current.commit(`duplicated ${els.map(layerName).join(", ")}`, (root) => {
          for (const b of els) {
            const t = byNid(root, nidOf(b)!)!;
            const copy = t.cloneNode(true) as HTMLElement;
            renumber(root, copy);
            t.parentElement!.insertBefore(copy, t);
            t.parentElement!.insertBefore(root.ownerDocument.createTextNode("\n"), t);
          }
        });
        drawWorld(world, props.current.root);
      }
      const items = els.map((b) => ({ nid: nidOf(b)!, frame: frameOf(world, nidOf(b)!)!, bx: boardBox(b).x, by: boardBox(b).y })).filter((i) => i.frame);
      const moving = items.map((i) => toDesign(i.frame.getBoundingClientRect(), vp, v)).reduce(union);
      return { kind: "boards", x: e.clientX, y: e.clientY, items, targets: targetsFor(world, vp, v, null, items.map((i) => i.nid), moving) } satisfies Gesture;
    }
    const primary = model(g.target);
    if (!primary || isBoard(primary)) return null;
    if (g.alt) {
      // Alt-drag leaves a copy where the layer was and moves the layer itself.
      props.current.commit(`duplicated ${layerName(primary)}`, (root) => {
        const el = byNid(root, g.target)!;
        const copy = el.cloneNode(true) as HTMLElement;
        renumber(root, copy);
        el.parentElement!.insertBefore(copy, el);
        el.parentElement!.insertBefore(root.ownerDocument.createTextNode("\n"), el);
      });
      drawWorld(world, props.current.root);
    }
    const parent = primary.parentElement!;
    if (isAbsolute(primary)) {
      const siblings = sel.map(model).filter((x): x is HTMLElement => !!x && x.parentElement === parent && isAbsolute(x));
      const items = siblings.map((m) => {
        const el = drawnOf(world, nidOf(m)!)!;
        return { nid: nidOf(m)!, el, left: px(m.style.left) ?? el.offsetLeft, top: px(m.style.top) ?? el.offsetTop };
      });
      const moving = items.map((i) => toDesign(i.el.getBoundingClientRect(), vp, v)).reduce(union);
      return { kind: "free", x: e.clientX, y: e.clientY, items, targets: targetsFor(world, vp, v, nidOf(parent), items.map((i) => i.nid), moving) } satisfies Gesture;
    }
    const el = drawnOf(world, g.target);
    if (!el) return null;
    el.classList.add("dz-ghost");
    return { kind: "reorder", x: e.clientX, y: e.clientY, nid: g.target, el, drop: null } satisfies Gesture;
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const shadow = shadowRef.current;
    if (!shadow) return;
    if (!g) {
      if (tool === "move" && !editing) {
        const chain = chainAt(shadow, e.clientX, e.clientY);
        const h = chain.length ? (modKey(e) ? chain.at(-1)! : pickInChain(chain, props.current.selection, props.current.root)) : null;
        if (h !== hover) setHover(h);
        if (e.altKey && h && props.current.selection.length) showMeasure(h);
      }
      return;
    }
    const v = viewRef.current;
    const dx = (e.clientX - g.x) / v.z;
    const dy = (e.clientY - g.y) / v.z;
    if (g.kind === "pan") {
      applyView({ ...g.view, x: g.view.x + (e.clientX - g.x), y: g.view.y + (e.clientY - g.y) });
      return;
    }
    if (g.kind === "press") {
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < 3) return;
      gesture.current = startDrag(g, e);
      return;
    }
    if (g.kind === "marquee") {
      const vp = vpRect();
      const m = { x0: Math.min(g.x, e.clientX) - vp.left, y0: Math.min(g.y, e.clientY) - vp.top, x1: Math.max(g.x, e.clientX) - vp.left, y1: Math.max(g.y, e.clientY) - vp.top };
      setOv((o) => ({ ...o, marquee: m }));
      select([...new Set([...g.base, ...marqueeHits(m)])]);
      return;
    }
    if (g.kind === "boards") {
      const s = g.targets.snapMove(dx, dy, threshold(e));
      for (const i of g.items) {
        i.frame.style.left = `${Math.round(i.bx + dx + s.dx)}px`;
        i.frame.style.top = `${Math.round(i.by + dy + s.dy)}px`;
      }
      setOv((o) => ({ ...o, guides: s.guides }));
      measure();
      return;
    }
    if (g.kind === "free") {
      const s = g.targets.snapMove(dx, dy, threshold(e));
      for (const i of g.items) {
        i.el.style.left = `${Math.round(i.left + dx + s.dx)}px`;
        i.el.style.top = `${Math.round(i.top + dy + s.dy)}px`;
      }
      setOv((o) => ({ ...o, guides: s.guides }));
      measure();
      return;
    }
    if (g.kind === "reorder") {
      g.el.style.transform = `translate(${dx}px, ${dy}px)`;
      measure();
      const root = props.current.root;
      const skip = new Set([g.nid]);
      const target = containerAt(shadow, root, e.clientX, e.clientY, skip, canHold);
      const vp = vpRect();
      if (!target) {
        g.drop = null;
        setOv((o) => ({ ...o, line: null }));
        return;
      }
      const tEl = model(target)!;
      const kind = layoutKind(tEl);
      const drawn = drawnOf(worldRef.current!, target)!;
      if (kind.free) {
        const cr = toDesign(drawn.getBoundingClientRect(), vp, v);
        const own = toDesign(g.el.getBoundingClientRect(), vp, v);
        g.drop = { parent: target, index: -1, free: { left: Math.round(own.x0 - cr.x0), top: Math.round(own.y0 - cr.y0) } };
        setOv((o) => ({ ...o, line: null }));
        return;
      }
      const spot = dropSpot(drawn, kind.layout, e.clientX, e.clientY, g.nid);
      g.drop = { parent: target, index: spot.index };
      setOv((o) => ({ ...o, line: { x0: spot.line.x0 - vp.left, y0: spot.line.y0 - vp.top, x1: spot.line.x1 - vp.left, y1: spot.line.y1 - vp.top } }));
      return;
    }
    if (g.kind === "resize") {
      resizeMove(g, dx, dy, e);
      return;
    }
    if (g.kind === "draw") {
      const vp = vpRect();
      setOv((o) => ({ ...o, draw: { x0: Math.min(g.x, e.clientX) - vp.left, y0: Math.min(g.y, e.clientY) - vp.top, x1: Math.max(g.x, e.clientX) - vp.left, y1: Math.max(g.y, e.clientY) - vp.top } }));
    }
  };

  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    setOv((o) => ({ ...o, guides: [], line: null, marquee: null, draw: null, size: null }));
    if (!g) return;
    const v = viewRef.current;
    const dx = (e.clientX - g.x) / v.z;
    const dy = (e.clientY - g.y) / v.z;
    if (g.kind === "boards") {
      const moves = g.items.map((i) => ({ nid: i.nid, x: px(i.frame.style.left) ?? i.bx, y: px(i.frame.style.top) ?? i.by }));
      props.current.commit(moves.length > 1 ? `moved ${moves.length} boards` : `moved board ${layerName(model(moves[0]!.nid)!)}`, (root) => {
        for (const m of moves) {
          const b = byNid(root, m.nid);
          b?.setAttribute("data-x", String(m.x));
          b?.setAttribute("data-y", String(m.y));
        }
      });
    } else if (g.kind === "free") {
      const moves = g.items.map((i) => ({ nid: i.nid, left: px(i.el.style.left) ?? i.left, top: px(i.el.style.top) ?? i.top }));
      if (Math.abs(dx) + Math.abs(dy) > 0)
        props.current.commit(`moved ${moves.map((m) => layerName(model(m.nid)!)).join(", ")}`, (root) => {
          for (const m of moves) {
            const el = byNid(root, m.nid);
            if (!el) continue;
            styleSet(el, { left: `${m.left}px`, top: `${m.top}px` });
          }
        });
    } else if (g.kind === "reorder") {
      g.el.classList.remove("dz-ghost");
      g.el.style.transform = "";
      const drop = g.drop;
      if (drop) {
        const el = model(g.nid)!;
        const name = layerName(el);
        const into = layerName(model(drop.parent)!);
        const same = nidOf(el.parentElement) === drop.parent;
        props.current.commit(drop.free ? `moved ${name} in ${into}` : same ? `moved ${name} to place ${drop.index + 1} in ${into}` : `moved ${name} into ${into}`, (root) => {
          const node = byNid(root, g.nid)!;
          const parent = byNid(root, drop.parent)!;
          const kids = [...parent.children].filter((k) => k.hasAttribute("data-nid") && k !== node);
          removeLayer(node);
          if (drop.free) {
            styleSet(node, { position: "absolute", left: `${drop.free.left}px`, top: `${drop.free.top}px` });
            insertWithNewline(parent, node, null);
          } else {
            if (isAbsolute(node)) styleSet(node, { position: null, left: null, top: null });
            insertWithNewline(parent, node, kids[drop.index] ?? null);
          }
        });
      } else drawWorld(worldRef.current!, props.current.root);
    } else if (g.kind === "resize") {
      resizeEnd(g);
    } else if (g.kind === "draw") {
      drawEnd(g, e);
    }
    measure();
  };

  const marqueeHits = (m: Rect): string[] => {
    const world = worldRef.current;
    const vp = vpRect();
    if (!world) return [];
    const inside = (r: DOMRect) => {
      const s = { x0: r.left - vp.left, y0: r.top - vp.top, x1: r.right - vp.left, y1: r.bottom - vp.top };
      return s.x0 < m.x1 && s.x1 > m.x0 && s.y0 < m.y1 && s.y1 > m.y0;
    };
    const layers: string[] = [];
    for (const b of boardsOf(props.current.root)) {
      const frame = frameOf(world, nidOf(b)!);
      if (!frame) continue;
      const fr = frame.getBoundingClientRect();
      const fs = { x0: fr.left - vp.left, y0: fr.top - vp.top, x1: fr.right - vp.left, y1: fr.bottom - vp.top };
      // A board entirely inside the box is selected whole; otherwise its top layers that the box touches.
      if (fs.x0 >= m.x0 && fs.x1 <= m.x1 && fs.y0 >= m.y0 && fs.y1 <= m.y1) {
        layers.push(nidOf(b)!);
        continue;
      }
      for (const c of b.children) {
        const n = nidOf(c);
        const d = n ? drawnOf(world, n) : null;
        if (n && d && inside(d.getBoundingClientRect())) layers.push(n);
      }
    }
    return layers;
  };

  // ---- resize
  const startResize = (handle: string, e: RPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!guard()) return;
    const nid = props.current.selection[0];
    const world = worldRef.current;
    if (!nid || !world) return;
    const m = model(nid)!;
    const board = isBoard(m);
    const el = board ? frameOf(world, nid)! : drawnOf(world, nid)!;
    const vp = vpRect();
    const v = viewRef.current;
    const start = toDesign(el.getBoundingClientRect(), vp, v);
    vpRef.current?.setPointerCapture(e.pointerId);
    gesture.current = {
      kind: "resize",
      x: e.clientX,
      y: e.clientY,
      nid,
      handle,
      start,
      el,
      board,
      targets: targetsFor(world, vp, v, board ? null : nidOf(m.parentElement), [nid], start),
      left: board ? null : isAbsolute(m) ? (px(m.style.left) ?? el.offsetLeft) : null,
      top: board ? null : isAbsolute(m) ? (px(m.style.top) ?? el.offsetTop) : null,
    };
  };

  const resizeMove = (g: Extract<Gesture, { kind: "resize" }>, dx: number, dy: number, e: PointerEvent | RPointerEvent) => {
    const s = g.start;
    let { x0, y0, x1, y1 } = s;
    const h = g.handle;
    if (h.includes("w")) x0 += dx;
    if (h.includes("e")) x1 += dx;
    if (h.includes("n")) y0 += dy;
    if (h.includes("s")) y1 += dy;
    // The moving edges snap to the other layers' lines.
    const sx = h.includes("w") ? x0 : x1;
    const sy = h.includes("n") ? y0 : y1;
    const snap = g.targets.snapPoint(sx, sy, threshold(e), { x: h.includes("w") || h.includes("e"), y: h.includes("n") || h.includes("s") });
    if (h.includes("w")) x0 += snap.dx;
    if (h.includes("e")) x1 += snap.dx;
    if (h.includes("n")) y0 += snap.dy;
    if (h.includes("s")) y1 += snap.dy;
    if (e.shiftKey && h.length === 2) {
      const ratio = (s.x1 - s.x0) / Math.max(1, s.y1 - s.y0);
      const w = x1 - x0;
      const hh = w / ratio;
      if (h.includes("n")) y0 = y1 - hh;
      else y1 = y0 + hh;
    }
    if (e.altKey) {
      if (h.includes("w") || h.includes("e")) {
        const d = h.includes("w") ? s.x0 - x0 : x1 - s.x1;
        x0 = s.x0 - d;
        x1 = s.x1 + d;
      }
      if (h.includes("n") || h.includes("s")) {
        const d = h.includes("n") ? s.y0 - y0 : y1 - s.y1;
        y0 = s.y0 - d;
        y1 = s.y1 + d;
      }
    }
    const w = Math.max(1, Math.round(x1 - x0));
    const hh = Math.max(1, Math.round(y1 - y0));
    if (h.includes("w") || h.includes("e")) g.el.style.width = `${w}px`;
    if (h.includes("n") || h.includes("s")) g.el.style[g.board ? "minHeight" : "height"] = `${hh}px`;
    if (g.board) {
      g.el.style.left = `${Math.round(x0)}px`;
      g.el.style.top = `${Math.round(y0)}px`;
    } else if (g.left !== null && g.top !== null) {
      g.el.style.left = `${Math.round(g.left + (x0 - s.x0))}px`;
      g.el.style.top = `${Math.round(g.top + (y0 - s.y0))}px`;
    }
    setOv((o) => ({ ...o, guides: snap.guides, size: `${w} × ${hh}` }));
    measure();
  };

  const resizeEnd = (g: Extract<Gesture, { kind: "resize" }>) => {
    const h = g.handle;
    const w = px(g.el.style.width);
    const hh = px(g.board ? g.el.style.minHeight : g.el.style.height);
    const left = px(g.el.style.left);
    const top = px(g.el.style.top);
    props.current.commit(`resized ${layerName(model(g.nid)!)}`, (root) => {
      const el = byNid(root, g.nid)!;
      if (g.board) {
        if (w !== null && (h.includes("w") || h.includes("e"))) el.setAttribute("data-w", String(w));
        if (hh !== null && (h.includes("n") || h.includes("s"))) el.setAttribute("data-h", String(hh));
        if (left !== null) el.setAttribute("data-x", String(left));
        if (top !== null) el.setAttribute("data-y", String(top));
        return;
      }
      const parent = el.parentElement as HTMLElement;
      const pl = layoutKind(parent).layout;
      if (w !== null && (h.includes("w") || h.includes("e"))) {
        styleSet(el, { width: `${w}px`, ...(pl === "row" ? { flex: null } : {}) });
      }
      if (hh !== null && (h.includes("n") || h.includes("s"))) {
        styleSet(el, { height: `${hh}px`, ...(pl === "column" ? { flex: null } : {}) });
      }
      if (g.left !== null && left !== null) styleSet(el, { left: `${left}px` });
      if (g.top !== null && top !== null) styleSet(el, { top: `${top}px` });
    });
  };

  // ---- drawing new layers
  const makeLayer = (root: HTMLElement, kind: Tool, w: number | null, h: number | null): HTMLElement => {
    const doc = root.ownerDocument;
    const el = doc.createElement(kind === "text" ? "p" : "div");
    el.setAttribute("data-nid", newNid(root));
    if (kind === "text") {
      el.setAttribute("style", "margin: 0; font-size: 16px");
      el.textContent = "Text";
    } else if (kind === "frame") {
      el.setAttribute("data-name", "Frame");
      el.setAttribute("style", `display: flex; flex-direction: column; gap: 8px; padding: 16px; width: ${w ?? 240}px; height: ${h ?? 160}px; background: #ffffff; border: 1px solid #e5e5e5`);
    } else {
      el.setAttribute("style", `width: ${w ?? 120}px; height: ${h ?? 80}px; background: #d9d9d9`);
    }
    return el;
  };

  const drawEnd = (g: Extract<Gesture, { kind: "draw" }>, e: PointerEvent | RPointerEvent) => {
    setTool("move");
    if (!guard()) return;
    const v = viewRef.current;
    const vp = vpRect();
    const wPx = Math.abs(e.clientX - g.x) / v.z;
    const hPx = Math.abs(e.clientY - g.y) / v.z;
    const clicked = wPx < 4 && hPx < 4;
    const w = clicked ? null : Math.round(wPx);
    const h = clicked ? null : Math.round(hPx);
    const x0 = (Math.min(g.x, e.clientX) - vp.left - v.x) / v.z;
    const y0 = (Math.min(g.y, e.clientY) - vp.top - v.y) / v.z;
    if (!g.container) {
      if (g.tool !== "frame") return props.current.onToast("Draw inside a board, or use the frame tool (F) to make a new board.");
      let made = "";
      props.current.commit("added a board", (root) => {
        const doc = root.ownerDocument;
        const b = doc.createElement("section");
        made = newNid(root);
        b.setAttribute("data-board", `Board ${boardsOf(root).length + 1}`);
        b.setAttribute("data-nid", made);
        b.setAttribute("data-x", String(Math.round(x0)));
        b.setAttribute("data-y", String(Math.round(y0)));
        b.setAttribute("data-w", String(w ?? 1920));
        b.setAttribute("data-h", String(h ?? 1080));
        b.setAttribute("style", "display: flex; flex-direction: column; gap: 24px; padding: 48px; background: #ffffff; color: #111111");
        root.append(doc.createTextNode("\n"), b, doc.createTextNode("\n"));
      });
      if (made) select([made]);
      return;
    }
    const container = model(g.container)!;
    const kind = layoutKind(container);
    let made = "";
    let index = -1;
    if (!kind.free) {
      const drawn = drawnOf(worldRef.current!, g.container);
      if (drawn) index = dropSpot(drawn, kind.layout, g.x, g.y, "").index;
    }
    const cr = toDesign(drawnOf(worldRef.current!, g.container)!.getBoundingClientRect(), vp, v);
    props.current.commit(`added ${g.tool === "text" ? "text" : g.tool === "frame" ? "a frame" : "a box"} in ${layerName(container)}`, (root) => {
      const parent = byNid(root, g.container!)!;
      const el = makeLayer(root, g.tool, w, h);
      made = nidOf(el)!;
      if (kind.free) {
        styleSet(el, { position: "absolute", left: `${Math.round(x0 - cr.x0)}px`, top: `${Math.round(y0 - cr.y0)}px` });
        insertWithNewline(parent, el, null);
      } else {
        const kids = [...parent.children].filter((k) => k.hasAttribute("data-nid"));
        insertWithNewline(parent, el, index >= 0 ? (kids[index] ?? null) : null);
      }
    });
    if (made) {
      select([made]);
      if (g.tool === "text") requestAnimationFrame(() => startText(made));
    }
  };

  // ---- text
  const startText = (nid: string) => {
    if (!guard()) return;
    const el = drawnOf(worldRef.current!, nid);
    const m = model(nid);
    if (!el || !m || !isTextLayer(m)) return;
    el.setAttribute("contenteditable", m.children.length ? "true" : "plaintext-only");
    setEditing(nid);
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(range);
  };

  const commitText = useCallback(() => {
    const nid = editing;
    if (!nid) return;
    setEditing(null);
    const el = worldRef.current ? drawnOf(worldRef.current, nid) : null;
    if (!el) return;
    el.removeAttribute("contenteditable");
    const m = model(nid);
    if (!m) return;
    const text = el.textContent ?? "";
    const rich = m.children.length > 0;
    const html = el.innerHTML;
    if ((!rich && text === m.textContent) || (rich && html === m.innerHTML)) return;
    props.current.commit(`changed text of ${layerName(m)} to "${text.slice(0, 40)}"`, (root) => {
      const t = byNid(root, nid);
      if (!t) return;
      if (!rich) t.textContent = text;
      else {
        // Formatting typed or pasted is cleaned like any design text: inline tags only, no attributes but style.
        const tmp = root.ownerDocument.createElement("div");
        tmp.innerHTML = html;
        for (const x of tmp.querySelectorAll("*")) {
          if (!["b", "strong", "i", "em", "u", "s", "span", "br", "small", "mark", "code", "sub", "sup"].includes(x.nodeName.toLowerCase())) x.replaceWith(...x.childNodes);
          else for (const a of [...x.attributes]) if (a.name !== "data-nid") x.removeAttribute(a.name);
        }
        t.innerHTML = tmp.innerHTML;
      }
    });
    // editing reads the latest state on purpose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // ---- measuring with Alt
  const showMeasure = (other: string) => {
    const world = worldRef.current;
    if (!world) return;
    const vp = vpRect();
    const v = viewRef.current;
    const a = selRect();
    const oEl = frameOf(world, other) ?? drawnOf(world, other);
    if (!a || !oEl) return;
    const b = toDesign(oEl.getBoundingClientRect(), vp, v);
    const gs: Guide[] = [];
    const label = (d: number) => String(Math.round(d));
    const inside = a.x0 >= b.x0 && a.x1 <= b.x1 && a.y0 >= b.y0 && a.y1 <= b.y1;
    const my = (a.y0 + a.y1) / 2;
    const mx = (a.x0 + a.x1) / 2;
    if (inside) {
      gs.push({ x0: b.x0, y0: my, x1: a.x0, y1: my, label: label(a.x0 - b.x0) }, { x0: a.x1, y0: my, x1: b.x1, y1: my, label: label(b.x1 - a.x1) });
      gs.push({ x0: mx, y0: b.y0, x1: mx, y1: a.y0, label: label(a.y0 - b.y0) }, { x0: mx, y0: a.y1, x1: mx, y1: b.y1, label: label(b.y1 - a.y1) });
    } else {
      if (b.x0 >= a.x1) gs.push({ x0: a.x1, y0: my, x1: b.x0, y1: my, label: label(b.x0 - a.x1) });
      if (b.x1 <= a.x0) gs.push({ x0: b.x1, y0: my, x1: a.x0, y1: my, label: label(a.x0 - b.x1) });
      if (b.y0 >= a.y1) gs.push({ x0: mx, y0: a.y1, x1: mx, y1: b.y0, label: label(b.y0 - a.y1) });
      if (b.y1 <= a.y0) gs.push({ x0: mx, y0: b.y1, x1: mx, y1: a.y0, label: label(a.y0 - b.y1) });
    }
    setOv((o) => ({ ...o, guides: gs.filter((g) => Number(g.label) > 0) }));
  };

  // ---- keyboard
  const selectedEls = () => props.current.selection.map(model).filter((x): x is HTMLElement => !!x);

  const nudge = (dx: number, dy: number) => {
    const els = selectedEls();
    if (!els.length || !guard()) return;
    const first = els[0]!;
    if (els.every((x) => isBoard(x))) {
      props.current.commit("moved board", (root) => {
        for (const b of els) {
          const t = byNid(root, nidOf(b)!)!;
          const box = boardBox(t);
          t.setAttribute("data-x", String(box.x + dx));
          t.setAttribute("data-y", String(box.y + dy));
        }
      });
      return;
    }
    if (isAbsolute(first)) {
      const world = worldRef.current!;
      props.current.commit(`nudged ${layerName(first)}`, (root) => {
        for (const m of els) {
          const t = byNid(root, nidOf(m)!)!;
          if (!isAbsolute(t)) continue;
          const d = drawnOf(world, nidOf(m)!);
          styleSet(t, { left: `${(px(t.style.left) ?? d?.offsetLeft ?? 0) + dx}px`, top: `${(px(t.style.top) ?? d?.offsetTop ?? 0) + dy}px` });
        }
      });
      return;
    }
    // In a stack the arrows move the layer earlier or later, like Figma's auto layout.
    const step = dx < 0 || dy < 0 ? -1 : 1;
    props.current.commit(`moved ${layerName(first)} ${step < 0 ? "earlier" : "later"}`, (root) => {
      const t = byNid(root, nidOf(first)!)!;
      const sibs = [...t.parentElement!.children].filter((k) => k.hasAttribute("data-nid"));
      const i = sibs.indexOf(t);
      const j = i + step;
      if (j < 0 || j >= sibs.length) return;
      const parent = t.parentElement!;
      removeLayer(t);
      const rest = [...parent.children].filter((k) => k.hasAttribute("data-nid"));
      insertWithNewline(parent, t, step < 0 ? rest[j]! : (rest[j] ?? null));
    });
  };

  const resizeBy = (dw: number, dh: number) => {
    const els = selectedEls();
    if (!els.length || !guard()) return;
    const world = worldRef.current!;
    props.current.commit(`resized ${layerName(els[0]!)}`, (root) => {
      for (const m of els) {
        const t = byNid(root, nidOf(m)!)!;
        if (isBoard(t)) {
          const b = boardBox(t);
          t.setAttribute("data-w", String(Math.max(40, b.w + dw)));
          if (dh) t.setAttribute("data-h", String(Math.max(40, (b.h ?? frameOf(world, nidOf(m)!)?.offsetHeight ?? 600) + dh)));
          continue;
        }
        const d = drawnOf(world, nidOf(m)!);
        if (dw) styleSet(t, { width: `${Math.max(1, (px(t.style.width) ?? d?.offsetWidth ?? 0) + dw)}px` });
        if (dh) styleSet(t, { height: `${Math.max(1, (px(t.style.height) ?? d?.offsetHeight ?? 0) + dh)}px` });
      }
    });
  };

  const duplicate = () => {
    const els = selectedEls();
    if (!els.length || !guard()) return;
    const made: string[] = [];
    props.current.commit(`duplicated ${els.map(layerName).join(", ")}`, (root) => {
      for (const m of els) {
        const t = byNid(root, nidOf(m)!)!;
        const copy = t.cloneNode(true) as HTMLElement;
        renumber(root, copy);
        made.push(nidOf(copy)!);
        if (isBoard(t)) {
          const b = boardBox(t);
          copy.setAttribute("data-x", String(b.x + b.w + 80));
          copy.setAttribute("data-board", `${t.getAttribute("data-board")} copy`);
          root.append(root.ownerDocument.createTextNode("\n"), copy, root.ownerDocument.createTextNode("\n"));
        } else insertWithNewline(t.parentElement!, copy, t.nextSibling);
      }
    });
    select(made);
  };

  const remove = () => {
    const els = selectedEls();
    if (!els.length || !guard()) return;
    props.current.commit(`deleted ${els.map(layerName).join(", ")}`, (root) => {
      for (const m of els) {
        const t = byNid(root, nidOf(m)!);
        if (t) removeLayer(t);
      }
    }, []);
  };

  const wrap = () => {
    const els = selectedEls();
    if (!els.length || !guard()) return;
    const first = els[0]!;
    if (els.length === 1 && isContainer(first) && !isBoard(first) && first.children.length && !layoutKind(first).stack) {
      props.current.commit(`made ${layerName(first)} a stack`, (root) => {
        const t = byNid(root, nidOf(first)!)!;
        styleSet(t, { display: "flex", "flex-direction": "column", gap: "8px" });
        t.removeAttribute("data-layout");
        for (const c of t.children) if (c instanceof HTMLElement && isAbsolute(c)) styleSet(c, { position: null, left: null, top: null });
      });
      return;
    }
    if (els.some((x) => isBoard(x) || x.parentElement !== first.parentElement)) return props.current.onToast("Pick layers in the same frame to wrap them.");
    let made = "";
    props.current.commit(`wrapped ${els.map(layerName).join(", ")} in a stack`, (root) => {
      const parent = byNid(root, nidOf(first)!)!.parentElement!;
      const kids = els.map((m) => byNid(root, nidOf(m)!)!).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      const box = root.ownerDocument.createElement("div");
      made = newNid(root);
      box.setAttribute("data-nid", made);
      box.setAttribute("data-name", "Stack");
      box.setAttribute("style", `display: flex; flex-direction: ${layoutKind(parent as HTMLElement).layout === "row" ? "row" : "column"}; gap: 8px`);
      parent.insertBefore(box, kids[0]!);
      for (const k of kids) {
        removeLayer(k);
        insertWithNewline(box, k, null);
      }
    });
    if (made) select([made]);
  };

  const unwrap = () => {
    const els = selectedEls();
    const t = els[0];
    if (!t || els.length !== 1 || isBoard(t) || !t.children.length || isTextLayer(t) || !guard()) return;
    props.current.commit(`removed the frame around ${layerName(t)}'s layers`, (root) => {
      const x = byNid(root, nidOf(t)!)!;
      x.replaceWith(...x.childNodes);
    });
  };

  const reorderZ = (forward: boolean) => {
    const els = selectedEls();
    const t = els[0];
    if (!t || isBoard(t) || !guard()) return;
    nudge(forward ? 1 : -1, 0);
  };

  const copyHtml = () => {
    const els = selectedEls();
    if (!els.length) return;
    clip.current = els.map((m) => m.outerHTML);
    void navigator.clipboard?.writeText(clip.current.join("\n")).catch(() => undefined);
    props.current.onToast(els.length > 1 ? `Copied ${els.length} layers` : "Copied");
  };

  const paste = () => {
    if (!clip.current.length || !guard()) return;
    const els = selectedEls();
    const target = els[0];
    const made: string[] = [];
    props.current.commit("pasted layers", (root) => {
      const tmp = root.ownerDocument.createElement("div");
      tmp.innerHTML = clip.current.join("\n");
      const into = target ? byNid(root, nidOf(target)!) : null;
      for (const c of [...tmp.children]) {
        renumber(root, c);
        made.push(nidOf(c)!);
        if (c.hasAttribute("data-board")) root.append(root.ownerDocument.createTextNode("\n"), c);
        else if (into && isContainer(into) && !isTextLayer(into)) insertWithNewline(into, c, null);
        else if (into && into.parentElement) insertWithNewline(into.parentElement, c, into.nextSibling);
        else {
          const board = boardsOf(root)[0];
          if (board) insertWithNewline(board, c, null);
        }
      }
    });
    select(made);
  };

  const enter = () => {
    const t = selectedEls()[0];
    if (!t) return;
    if (isTextLayer(t)) return startText(nidOf(t)!);
    const child = [...t.children].find((c) => c.hasAttribute("data-nid"));
    if (child) select([nidOf(child)!]);
  };
  const toParent = () => {
    const t = selectedEls()[0];
    if (!t) return;
    const parent = t.parentElement;
    if (parent && parent.hasAttribute("data-nid")) select([nidOf(parent)!]);
    else select([]);
  };
  const sibling = (step: number) => {
    const t = selectedEls()[0];
    const sibs = t ? [...(t.parentElement?.children ?? [])].filter((k) => k.hasAttribute("data-nid")) : boardsOf(props.current.root);
    if (!sibs.length) return;
    const i = t ? sibs.indexOf(t) : -1;
    const next = sibs[(i + step + sibs.length) % sibs.length];
    if (next) select([nidOf(next)!]);
  };
  const selectAll = () => {
    const t = selectedEls()[0];
    const sibs = t?.parentElement?.hasAttribute("data-nid") ? [...t.parentElement.children] : boardsOf(props.current.root);
    select(sibs.map(nidOf).filter((n): n is string => !!n));
  };

  const onKeyDown = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (editing) {
      if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        commitText();
        vpRef.current?.focus();
      }
      return;
    }
    if ((e.target as HTMLElement).closest(".dz-ui input, .dz-ui textarea")) return;
    const mod = modKey(e);
    const k = e.key;
    const big = e.shiftKey ? 10 : 1;
    const handled = () => e.preventDefault();
    if (k === "Alt") setAlt(true);
    if (k === " " && !space) {
      setSpace(true);
      return handled();
    }
    if (mod && (k === "z" || k === "Z")) return; // the panel handles undo and redo
    if (mod && k.toLowerCase() === "l") {
      handled();
      return props.current.onAskAI();
    }
    if (k.startsWith("Arrow")) {
      handled();
      const dx = k === "ArrowLeft" ? -big : k === "ArrowRight" ? big : 0;
      const dy = k === "ArrowUp" ? -big : k === "ArrowDown" ? big : 0;
      return mod ? resizeBy(dx, dy) : nudge(dx, dy);
    }
    if (k === "Enter") {
      handled();
      if (e.shiftKey) return toParent();
      if (tool !== "move" && tool !== "hand") return placeWithKeyboard();
      return enter();
    }
    if (k === "Escape") {
      handled();
      if (tool !== "move") return setTool("move");
      if (menu) return setMenu(null);
      if (!props.current.selection.length) return props.current.onExit();
      return toParent();
    }
    if (k === "Tab") {
      handled();
      return sibling(e.shiftKey ? -1 : 1);
    }
    if (k === "Backspace" || k === "Delete") {
      handled();
      return remove();
    }
    if (mod && k.toLowerCase() === "d") {
      handled();
      return duplicate();
    }
    if (mod && k.toLowerCase() === "a") {
      handled();
      return selectAll();
    }
    if (mod && k.toLowerCase() === "c") {
      handled();
      return copyHtml();
    }
    if (mod && k.toLowerCase() === "v") {
      handled();
      return paste();
    }
    if (mod && e.shiftKey && k.toLowerCase() === "g") {
      handled();
      return unwrap();
    }
    if (e.shiftKey && !mod && k.toLowerCase() === "a") {
      handled();
      return wrap();
    }
    if (mod && (k === "]" || k === "[")) {
      handled();
      return reorderZ(k === "]");
    }
    if (e.shiftKey && (e.code === "Digit1" || e.code === "Digit2" || e.code === "Digit0")) {
      handled();
      if (e.code === "Digit1") return fitAll();
      if (e.code === "Digit2") return fitRect(selRect());
      const vp = vpRect();
      return zoomAt(1, vp.width / 2, vp.height / 2);
    }
    if (mod && (k === "=" || k === "+" || k === "-")) {
      handled();
      const vp = vpRect();
      return zoomAt(viewRef.current.z * (k === "-" ? 1 / 1.25 : 1.25), vp.width / 2, vp.height / 2);
    }
    if (k === "?") {
      handled();
      return props.current.onShortcuts();
    }
    if (!mod && !e.altKey) {
      const tools: Record<string, Tool> = { v: "move", f: "frame", r: "box", t: "text", h: "hand" };
      const next = tools[k.toLowerCase()];
      if (next) {
        handled();
        setTool(next);
      }
    }
  };
  const onKeyUp = (e: RKeyboardEvent) => {
    if (e.key === " ") setSpace(false);
    if (e.key === "Alt") {
      setAlt(false);
      setOv((o) => ({ ...o, guides: [] }));
    }
  };

  /** Enter with a drawing tool: puts a new layer of the default size into the selected frame (or after the selected layer). */
  const placeWithKeyboard = () => {
    if (!guard()) return;
    const t = selectedEls()[0] ?? boardsOf(props.current.root)[0];
    if (!t) return props.current.onToast("Make a board first (F, then click on the canvas).");
    const into = isContainer(t) && !isTextLayer(t) ? t : (t.parentElement as HTMLElement);
    const kind = tool;
    let made = "";
    props.current.commit(`added ${kind === "text" ? "text" : kind === "frame" ? "a frame" : "a box"} in ${layerName(into)}`, (root) => {
      const parent = byNid(root, nidOf(into)!)!;
      const el = makeLayer(root, kind, null, null);
      made = nidOf(el)!;
      if (layoutKind(parent).free) {
        styleSet(el, { position: "absolute", left: "24px", top: "24px" });
      }
      insertWithNewline(parent, el, into === t ? null : t.nextSibling);
    });
    setTool("move");
    if (made) {
      select([made]);
      if (kind === "text") requestAnimationFrame(() => startText(made));
    }
  };

  const onDoubleClick = (e: RMouseEvent) => {
    const shadow = shadowRef.current;
    if (!shadow || tool !== "move") return;
    const chain = chainAt(shadow, e.clientX, e.clientY);
    if (!chain.length) return;
    const sel = props.current.selection[0];
    const i = sel ? chain.indexOf(sel) : -1;
    if (i >= 0 && i < chain.length - 1) {
      const next = chain[i + 1]!;
      const m = model(next);
      // Into a text layer that is the last thing under the pointer: edit it straight away.
      if (m && isTextLayer(m) && i + 1 === chain.length - 1) {
        select([next]);
        return startText(next);
      }
      return select([next]);
    }
    const target = sel && i >= 0 ? sel : chain.at(-1)!;
    const m = model(target);
    if (m && isTextLayer(m)) {
      select([target]);
      startText(target);
    }
  };

  const onContextMenu = (e: RMouseEvent) => {
    e.preventDefault();
    const shadow = shadowRef.current;
    if (!shadow) return;
    const chain = chainAt(shadow, e.clientX, e.clientY);
    if (chain.length) {
      const target = pickInChain(chain, props.current.selection, props.current.root)!;
      if (!props.current.selection.includes(target)) select([target]);
    }
    const vp = vpRect();
    setMenu({ x: e.clientX - vp.left, y: e.clientY - vp.top });
  };

  // ---- overlay
  const selBox = ov.sel.length ? ov.sel.reduce(union) : null;
  const single = p.selection.length === 1 ? model(p.selection[0]!) : null;
  const cursor = space || tool === "hand" ? (gesture.current?.kind === "pan" ? "grabbing" : "grab") : tool === "move" ? "default" : "crosshair";
  const lineRect = (g: Rect) => ({ left: Math.min(g.x0, g.x1), top: Math.min(g.y0, g.y1), width: Math.max(1, Math.abs(g.x1 - g.x0)), height: Math.max(1, Math.abs(g.y1 - g.y0)) });
  const toolBtn = (t: Tool, label: string, key: string, icon: ReactNode) => (
    <button type="button" className={`dz-tool ${tool === t ? "on" : ""}`} aria-pressed={tool === t} title={`${label} (${key})`} aria-label={label} onClick={() => setTool(t)}>
      {icon}
    </button>
  );
  const selectedBoards = useMemo(() => p.selection.map((n) => byNid(p.root, n)).filter((x): x is HTMLElement => !!x && isBoard(x)).map((b) => b.getAttribute("data-board") ?? ""), [p.selection, p.root, p.version]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={vpRef}
      className="dz-viewport"
      tabIndex={0}
      role="application"
      aria-label="Design canvas. Arrow keys move the selection, Enter goes into a layer, Escape goes out, question mark lists the shortcuts."
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => !gesture.current && setHover(null)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={() => {
        setSpace(false);
        setAlt(false);
      }}
      onClickCapture={(e) => e.preventDefault()}
      onAuxClickCapture={(e) => e.preventDefault()}
    >
      <div ref={hostRef} className="dz-host" />
      <div className="dz-overlay" aria-hidden>
        {ov.boards.map((b) => (
          <button
            key={b.nid}
            type="button"
            className={`dz-board-name dz-ui ${p.selection.includes(b.nid) ? "on" : ""}`}
            style={{ left: b.r.x0, top: b.r.y0 - 20, maxWidth: Math.max(40, b.r.x1 - b.r.x0) }}
            onPointerDown={(e) => {
              e.stopPropagation();
              vpRef.current?.focus();
              if (!props.current.selection.includes(b.nid)) select(e.shiftKey ? [...props.current.selection, b.nid] : [b.nid]);
              vpRef.current?.setPointerCapture(e.pointerId);
              gesture.current = { kind: "press", x: e.clientX, y: e.clientY, target: b.nid, alt: e.altKey, shift: false };
            }}
            tabIndex={-1}
          >
            {b.name}
          </button>
        ))}
        {ov.boards.map((b) =>
          b.code ? (
            <span key={`c${b.nid}`} className={`dz-code-tag dz-ui ${b.code.changed ? "changed" : ""}`} style={{ left: b.r.x0, top: b.r.y1 + 6 }}>
              <button type="button" tabIndex={-1} onClick={() => props.current.onOpenCode(b.code!.path)} title={`Open ${b.code.path}`}>
                {"</>"} {b.code.changed ? "Changed since code" : `In code · ${b.code.path.split("/").pop()}`}
              </button>
              {b.code.changed && (
                <button type="button" tabIndex={-1} className="strong" onClick={() => props.current.onUpdateCode([b.name])}>
                  Update code
                </button>
              )}
            </span>
          ) : null,
        )}
        {ov.hover && !gesture.current && <div className="dz-hover" style={lineRect(ov.hover)} />}
        {ov.sel.map((r, i) => (
          <div key={i} className="dz-sel" style={lineRect(r)} />
        ))}
        {ov.flash.map((r, i) => (
          <div key={`f${i}`} className="dz-flash" style={lineRect(r)} />
        ))}
        {selBox && single && !p.readOnly && !editing && !gesture.current && (
          <>
            {HANDLES.map((h) => {
              const x = h.includes("w") ? selBox.x0 : h.includes("e") ? selBox.x1 : (selBox.x0 + selBox.x1) / 2;
              const y = h.includes("n") ? selBox.y0 : h.includes("s") ? selBox.y1 : (selBox.y0 + selBox.y1) / 2;
              return <div key={h} className={`dz-handle dz-ui h-${h}`} style={{ left: x - 4, top: y - 4 }} onPointerDown={(e) => startResize(h, e)} />;
            })}
          </>
        )}
        {selBox && (ov.size || single) && (
          <div className="dz-size" style={{ left: (selBox.x0 + selBox.x1) / 2, top: selBox.y1 + 6 }}>
            {ov.size ?? `${Math.round((selBox.x1 - selBox.x0) / view.z)} × ${Math.round((selBox.y1 - selBox.y0) / view.z)}`}
          </div>
        )}
        {ov.guides.map((g, i) => {
          const s = toScreen({ x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 }, view);
          return (
            <div key={`g${i}`}>
              <div className="dz-guide" style={lineRect(s)} />
              {g.label && (
                <span className="dz-guide-label" style={{ left: (s.x0 + s.x1) / 2, top: (s.y0 + s.y1) / 2 }}>
                  {g.label}
                </span>
              )}
            </div>
          );
        })}
        {ov.line && <div className="dz-drop-line" style={lineRect(ov.line)} />}
        {ov.marquee && <div className="dz-marquee" style={lineRect(ov.marquee)} />}
        {ov.draw && <div className="dz-draw" style={lineRect(ov.draw)} />}
      </div>

      {selBox && !gesture.current && !editing && p.selection.length > 0 && !menu && (
        <div className="dz-mini dz-ui" style={{ left: selBox.x0, top: selBox.y1 + (single ? 28 : 8) }}>
          <button type="button" className="dz-mini-ai" onClick={() => props.current.onAskAI()} title="Ask the AI about this (⌘L)">
            <Sparkles size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Ask AI
          </button>
          {!p.readOnly && (
            <>
              <button type="button" onClick={duplicate} title="Duplicate (⌘D)" aria-label="Duplicate">
                <Copy size={ICON_SM} strokeWidth={STROKE} />
              </button>
              <button type="button" onClick={remove} title="Delete (⌫)" aria-label="Delete">
                <Trash2 size={ICON_SM} strokeWidth={STROKE} />
              </button>
            </>
          )}
        </div>
      )}

      {menu && (
        <div className="menu dz-menu dz-ui" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          {p.selection.length > 0 && (
            <button type="button" role="menuitem" className="menu-item" onClick={() => (setMenu(null), props.current.onAskAI())}>
              <Sparkles size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Ask AI about this
            </button>
          )}
          {selectedBoards.length > 0 && (
            <button type="button" role="menuitem" className="menu-item" onClick={() => (setMenu(null), props.current.onBuild(selectedBoards))}>
              {"</>"} Build in code
            </button>
          )}
          {!p.readOnly && p.selection.length > 0 && (
            <>
              <button type="button" role="menuitem" className="menu-item" onClick={() => (setMenu(null), duplicate())}>
                Duplicate <span className="menu-kbd">⌘D</span>
              </button>
              <button type="button" role="menuitem" className="menu-item" onClick={() => (setMenu(null), wrap())}>
                Wrap in stack <span className="menu-kbd">⇧A</span>
              </button>
              <button type="button" role="menuitem" className="menu-item" onClick={() => (setMenu(null), copyHtml())}>
                Copy <span className="menu-kbd">⌘C</span>
              </button>
              <button type="button" role="menuitem" className="menu-item danger" onClick={() => (setMenu(null), remove())}>
                Delete <span className="menu-kbd">⌫</span>
              </button>
            </>
          )}
          {!p.readOnly && clip.current.length > 0 && (
            <button type="button" role="menuitem" className="menu-item" onClick={() => (setMenu(null), paste())}>
              Paste <span className="menu-kbd">⌘V</span>
            </button>
          )}
          <button type="button" role="menuitem" className="menu-item" onClick={() => (setMenu(null), fitAll())}>
            Zoom to fit <span className="menu-kbd">⇧1</span>
          </button>
        </div>
      )}

      <div className="dz-tools dz-ui" role="toolbar" aria-label="Tools">
        {toolBtn("move", "Move", "V", <MousePointer2 size={ICON_SM} strokeWidth={STROKE} />)}
        {toolBtn("frame", "Frame", "F", <FrameIcon size={ICON_SM} strokeWidth={STROKE} />)}
        {toolBtn("text", "Text", "T", <Type size={ICON_SM} strokeWidth={STROKE} />)}
        {toolBtn("box", "Box", "R", <Square size={ICON_SM} strokeWidth={STROKE} />)}
        {toolBtn("hand", "Hand", "H", <Hand size={ICON_SM} strokeWidth={STROKE} />)}
      </div>
      <div className="dz-zoom dz-ui">
        <button type="button" aria-label="Zoom out" onClick={() => zoomAt(viewRef.current.z / 1.25, vpRect().width / 2, vpRect().height / 2)}>
          <Minus size={ICON_SM} strokeWidth={STROKE} />
        </button>
        <button type="button" className="dz-zoom-val" title="Zoom to fit (⇧1)" onClick={fitAll}>
          {Math.round(view.z * 100)}%
        </button>
        <button type="button" aria-label="Zoom in" onClick={() => zoomAt(viewRef.current.z * 1.25, vpRect().width / 2, vpRect().height / 2)}>
          <Plus size={ICON_SM} strokeWidth={STROKE} />
        </button>
      </div>
      {alt && <span className="sr-only">Measuring</span>}
    </div>
  );
});

/** Boards whose design changed since they were built, and their code files. */
export function codeLink(board: HTMLElement): { path: string; changed: boolean } | null {
  const path = board.getAttribute("data-code");
  if (!path) return null;
  const built = board.getAttribute("data-built");
  return { path, changed: !!built && built !== boardHash(board) };
}

