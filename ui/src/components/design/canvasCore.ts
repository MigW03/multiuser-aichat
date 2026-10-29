import { boardBox, boardsOf, byNid, isStack, layoutOf, nidOf, type Layout } from "../../lib/designModel.ts";
import { Targets, type Rect } from "../../lib/designSnap.ts";

// The parts of the canvas that are plain DOM work: drawing the design into a shadow root, and measuring what is drawn.
// The model (the parsed design) is never put in the page; the canvas draws a copy of it and maps layers by data-nid.

export const SHADOW_CSS = `
:host { all: initial; display: block; position: absolute; inset: 0; overflow: hidden; }
.world { position: absolute; left: 0; top: 0; transform-origin: 0 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 16px; line-height: normal; color: #111; }
.world *, .world *::before, .world *::after { box-sizing: border-box; }
.frame { position: absolute; background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,0.08), 0 2px 10px rgba(0,0,0,0.06); }
.frame > [data-board] { width: 100% !important; min-height: inherit; margin: 0 !important; position: relative; }
.world img { max-width: none; }
.world [data-nid].dz-ghost { opacity: 0.55; pointer-events: none; }
.world [contenteditable] { outline: none; cursor: text; }
`;

export type View = { x: number; y: number; z: number };

/** Draws the design into the world element: one positioned frame per board, holding a copy of the board. */
export function drawWorld(world: HTMLElement, root: HTMLElement) {
  const doc = world.ownerDocument;
  world.replaceChildren();
  for (const board of boardsOf(root)) {
    const b = boardBox(board);
    const frame = doc.createElement("div");
    frame.className = "frame";
    frame.dataset.frame = nidOf(board) ?? "";
    frame.style.left = `${b.x}px`;
    frame.style.top = `${b.y}px`;
    frame.style.width = `${b.w}px`;
    if (b.h !== null) frame.style.minHeight = `${b.h}px`;
    const copy = doc.importNode(board, true) as HTMLElement;
    // Nothing in the drawing takes focus or follows a link: the canvas handles every key and click itself.
    for (const el of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
      if (el.matches("a, button, input, select, textarea, [tabindex], summary, details")) el.setAttribute("tabindex", "-1");
      if (el.hasAttribute("href")) el.setAttribute("href", "#");
    }
    frame.append(copy);
    world.append(frame);
  }
}

/** The drawn copy of a layer (or the frame of a board). */
export const drawnOf = (world: HTMLElement, nid: string): HTMLElement | null => byNid(world, nid);
export const frameOf = (world: HTMLElement, nid: string): HTMLElement | null => world.querySelector<HTMLElement>(`.frame[data-frame="${nid}"]`);

/** Screen (client) rectangle to design coordinates. */
export function toDesign(r: DOMRect, vp: DOMRect, v: View): Rect {
  return { x0: (r.left - vp.left - v.x) / v.z, y0: (r.top - vp.top - v.y) / v.z, x1: (r.right - vp.left - v.x) / v.z, y1: (r.bottom - vp.top - v.y) / v.z };
}
/** Design rectangle to viewport-relative screen coordinates. */
export function toScreen(r: Rect, v: View): Rect {
  return { x0: r.x0 * v.z + v.x, y0: r.y0 * v.z + v.y, x1: r.x1 * v.z + v.x, y1: r.y1 * v.z + v.y };
}

/** The data-nid chain under a point, from the board down to the deepest layer. Skips layers marked as ghosts (being dragged). */
export function chainAt(shadow: ShadowRoot, x: number, y: number, skip?: Set<string>): string[] {
  const hits = shadow.elementsFromPoint(x, y);
  let leaf: Element | null = null;
  for (const h of hits) {
    if (h.closest(".dz-ghost")) continue;
    const el = h.closest("[data-nid]");
    if (el && !(skip && [...skip].some((s) => el.closest(`[data-nid="${s}"]`)))) {
      leaf = el;
      break;
    }
  }
  const chain: string[] = [];
  for (let cur: Element | null = leaf; cur && cur.hasAttribute("data-nid"); cur = cur.parentElement) chain.unshift(cur.getAttribute("data-nid")!);
  return chain;
}

/**
 * Which layer a click selects, the way Figma does: a selected layer under the pointer stays selected (so it can be
 * dragged by any part); otherwise a layer at the same level as the selection; otherwise the top layer of the board.
 */
export function pickInChain(chain: string[], selection: string[], root: HTMLElement): string | null {
  if (chain.length === 0) return null;
  const selected = chain.filter((n) => selection.includes(n));
  if (selected.length) return selected.at(-1)!;
  for (const s of selection) {
    const parent = byNid(root, s)?.parentElement;
    const pid = nidOf(parent);
    const i = pid ? chain.indexOf(pid) : -1;
    if (i >= 0 && chain[i + 1]) return chain[i + 1]!;
  }
  return chain[1] ?? chain[0]!;
}

export const px = (v: string | undefined | null): number | null => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec((v ?? "").trim());
  return m ? Number(m[1]) : null;
};

export const isAbsolute = (el: HTMLElement) => el.style.position === "absolute";

/** Snap targets for layers moving inside `parent`: its box and its other children. */
export function targetsFor(world: HTMLElement, vp: DOMRect, v: View, parentNid: string | null, moving: string[], movingRect: Rect | null): Targets {
  const parentEl = parentNid ? drawnOf(world, parentNid) : null;
  const parentRect = parentEl ? toDesign(parentEl.getBoundingClientRect(), vp, v) : null;
  const siblings: Rect[] = [];
  const kids = parentEl ? [...parentEl.children] : [...world.querySelectorAll(":scope > .frame")];
  for (const k of kids) {
    const nid = k.getAttribute("data-nid") ?? k.getAttribute("data-frame");
    if (!nid || moving.includes(nid)) continue;
    siblings.push(toDesign(k.getBoundingClientRect(), vp, v));
  }
  return new Targets(parentRect, siblings, movingRect);
}

/** Where a dragged layer would land among a container's children: the index and a line to show it. */
export function dropSpot(container: HTMLElement, layout: Layout, x: number, y: number, skip: string): { index: number; line: { x0: number; y0: number; x1: number; y1: number } } {
  const kids = [...container.children].filter((k): k is HTMLElement => k.hasAttribute("data-nid") && k.getAttribute("data-nid") !== skip);
  const cr = container.getBoundingClientRect();
  if (kids.length === 0) return { index: 0, line: { x0: cr.left + 8, y0: cr.top + 8, x1: cr.right - 8, y1: cr.top + 8 } };
  const horizontal = layout === "row";
  let index = kids.length;
  for (let i = 0; i < kids.length; i++) {
    const r = kids[i]!.getBoundingClientRect();
    const before = layout === "grid" ? y < r.top + r.height / 2 || (y < r.bottom && x < r.left + r.width / 2) : horizontal ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
    if (before) {
      index = i;
      break;
    }
  }
  const ref = kids[Math.min(index, kids.length - 1)]!.getBoundingClientRect();
  const after = index >= kids.length;
  if (horizontal || layout === "grid") {
    const lx = after ? ref.right + 2 : ref.left - 2;
    return { index, line: { x0: lx, y0: ref.top, x1: lx, y1: ref.bottom } };
  }
  const ly = after ? ref.bottom + 2 : ref.top - 2;
  return { index, line: { x0: ref.left, y0: ly, x1: ref.right, y1: ly } };
}

/** The container a layer dropped (or drawn) at a point goes into: the deepest layer under it that can hold layers. */
export function containerAt(shadow: ShadowRoot, root: HTMLElement, x: number, y: number, skip: Set<string>, canHold: (el: HTMLElement) => boolean): string | null {
  const chain = chainAt(shadow, x, y, skip);
  for (let i = chain.length - 1; i >= 0; i--) {
    const el = byNid(root, chain[i]!);
    if (el && canHold(el)) return chain[i]!;
  }
  return null;
}

export const layoutKind = (el: HTMLElement) => {
  const l = layoutOf(el);
  return { layout: l, stack: isStack(l), free: l === "free" };
};
