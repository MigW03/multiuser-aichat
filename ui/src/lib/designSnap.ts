// Snapping and smart guides for the design canvas: while moving or resizing, edges and centres snap to nearby layers'
// edges and centres and to the parent frame, a moving box also snaps to equal spacing with the boxes beside it, and the
// matches come back as guide lines (with spacing labels) for the canvas to draw in red.
//
// Ported from FigCraft's `crates/engine/src/snap.rs` (https://github.com/storytold/figcraft), MIT licence,
// Copyright (c) 2026 ArtCraft Team and the FigCraft contributors. Rotation and layout grids are left out: the canvas
// has neither. Everything here is in design coordinates (CSS px of the design, not of the screen).

export type Rect = { x0: number; y0: number; x1: number; y1: number };
/** A guide line from (x0, y0) to (x1, y1), with an optional distance label at its middle. */
export type Guide = { x0: number; y0: number; x1: number; y1: number; label?: string };
/** A line to snap: its position on one axis and the span it covers on the other. */
type Span = [number, number, number];
/** A gap along a row: from, to, and where across it is drawn. */
type Gap = [number, number, number];

/** FigCraft's snapping distance, in screen pixels (divide by the zoom for design px). */
export const SNAP_PX = 5;

export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x0: x, y0: y, x1: x + w, y1: y + h });
const cx = (r: Rect) => (r.x0 + r.x1) / 2;
const cy = (r: Rect) => (r.y0 + r.y1) / 2;
export const moved = (r: Rect, dx: number, dy: number): Rect => ({ x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy });
export const union = (a: Rect, b: Rect): Rect => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

const label = (d: number) => String(Math.round(d * 10) / 10);

function rectSpans(r: Rect): [Span[], Span[]] {
  return [
    [
      [r.x0, r.y0, r.y1],
      [cx(r), r.y0, r.y1],
      [r.x1, r.y0, r.y1],
    ],
    [
      [r.y0, r.x0, r.x1],
      [cy(r), r.x0, r.x1],
      [r.y1, r.x0, r.x1],
    ],
  ];
}

/** Snap candidates gathered once at the start of a gesture. */
export class Targets {
  xs: Span[] = [];
  ys: Span[] = [];
  boxes: Rect[] = [];

  /** `parent`: the frame the moving layers sit in. `siblings`: the other layers in it (or other boards, for boards). */
  constructor(parent: Rect | null, siblings: Rect[], readonly moving: Rect | null = null) {
    if (parent) {
      for (const x of [parent.x0, cx(parent), parent.x1]) this.xs.push([x, parent.y0, parent.y1]);
      for (const y of [parent.y0, cy(parent), parent.y1]) this.ys.push([y, parent.x0, parent.x1]);
    }
    for (const b of siblings) this.addBox(b);
  }

  addBox(r: Rect) {
    for (const x of [r.x0, cx(r), r.x1]) this.xs.push([x, r.y0, r.y1]);
    for (const y of [r.y0, cy(r), r.y1]) this.ys.push([y, r.x0, r.x1]);
    this.boxes.push(r);
  }

  /** Snap the moving box moved by (dx, dy): the correction to add, and the guides to draw. */
  snapMove(dx: number, dy: number, threshold: number): { dx: number; dy: number; guides: Guide[] } {
    if (!this.moving) return { dx: 0, dy: 0, guides: [] };
    const r = moved(this.moving, dx, dy);
    const [xs, ys] = rectSpans(r);
    let { dx: sx, dy: sy } = this.snapSpans(xs, ys, threshold);
    const ex = this.equalSpacing(r, threshold, true);
    if (ex !== null && (sx === null || Math.abs(ex) < Math.abs(sx))) sx = ex;
    const ey = this.equalSpacing(r, threshold, false);
    if (ey !== null && (sy === null || Math.abs(ey) < Math.abs(sy))) sy = ey;
    const c = { dx: sx ?? 0, dy: sy ?? 0 };
    const at = moved(r, c.dx, c.dy);
    return { ...c, guides: [...this.guidesFor(at), ...this.spacingGuides(at, true), ...this.spacingGuides(at, false)] };
  }

  /** Snap one point (a resize handle): the correction and the guides. */
  snapPoint(x: number, y: number, threshold: number, axes: { x: boolean; y: boolean } = { x: true, y: true }): { dx: number; dy: number; guides: Guide[] } {
    const r = this.snapSpans(axes.x ? [[x, y, y]] : [], axes.y ? [[y, x, x]] : [], threshold);
    return { dx: r.dx ?? 0, dy: r.dy ?? 0, guides: r.guides };
  }

  /** Snap moving lines: the nearest correction on each axis within `threshold`, and guides for lines that coincide afterwards. */
  snapSpans(xs: Span[], ys: Span[], threshold: number): { dx: number | null; dy: number | null; guides: Guide[] } {
    const best = (cands: Span[], vals: Span[]): number | null => {
      let b: number | null = null;
      for (const [line] of cands) {
        for (const [v] of vals) {
          const d = line - v;
          if (Math.abs(d) <= threshold && (b === null || Math.abs(d) < Math.abs(b))) b = d;
        }
      }
      return b;
    };
    const dx = best(this.xs, xs);
    const dy = best(this.ys, ys);
    const ox = dx ?? 0;
    const oy = dy ?? 0;
    const mx: Span[] = xs.map(([x, a, b]) => [x + ox, a + oy, b + oy]);
    const my: Span[] = ys.map(([y, a, b]) => [y + oy, a + ox, b + ox]);
    return { dx, dy, guides: this.guidesSpans(mx, my) };
  }

  guidesFor(r: Rect): Guide[] {
    const [xs, ys] = rectSpans(r);
    return this.guidesSpans(xs, ys);
  }

  private guidesSpans(xs: Span[], ys: Span[]): Guide[] {
    const span = (cands: Span[], [v, a, b]: Span): [number, number] | null => {
      const hits = cands.filter(([l]) => Math.abs(l - v) < 1e-6);
      if (!hits.length) return null;
      return [Math.max(-1e6, hits.reduce((m, h) => Math.min(m, h[1]), a)), Math.min(1e6, hits.reduce((m, h) => Math.max(m, h[2]), b))];
    };
    const out: Guide[] = [];
    for (const x of xs) {
      const s = span(this.xs, x);
      if (s) out.push({ x0: x[0], y0: s[0], x1: x[0], y1: s[1] });
    }
    for (const y of ys) {
      const s = span(this.ys, y);
      if (s) out.push({ x0: s[0], y0: y[0], x1: s[1], y1: y[0] });
    }
    return out;
  }

  /**
   * The ways `r` can be spaced equally in its row (`horizontal`) or column, worked out as a row: centred between its
   * nearest neighbours, as far after the one before it as that one is from the next, or as far before the one after it.
   */
  private spacings(r0: Rect, horizontal: boolean): [number, [Gap, Gap]][] {
    const t = (b: Rect): Rect => (horizontal ? b : { x0: b.y0, y0: b.x0, x1: b.y1, y1: b.x1 });
    const r = t(r0);
    const row = this.boxes.map(t).filter((b) => b.y0 < r.y1 && b.y1 > r.y0);
    const before = row.filter((b) => cx(b) < cx(r)).sort((a, b) => b.x1 - a.x1);
    const after = row.filter((b) => cx(b) >= cx(r)).sort((a, b) => a.x0 - b.x0);
    const mid = (a: Rect, b: Rect) => (Math.max(a.y0, b.y0) + Math.min(a.y1, b.y1)) / 2;
    const w = r.x1 - r.x0;
    const out: [number, [Gap, Gap]][] = [];
    const l = before[0];
    const n = after[0];
    if (l && n && n.x0 - l.x1 > w) {
      const x0 = (l.x1 + n.x0 - w) / 2;
      out.push([x0, [[l.x1, x0, mid(l, r)], [x0 + w, n.x0, mid(r, n)]]]);
    }
    const l2 = before[1];
    if (l && l2 && l.x0 > l2.x1) {
      const x0 = l.x1 + (l.x0 - l2.x1);
      out.push([x0, [[l2.x1, l.x0, mid(l2, l)], [l.x1, x0, mid(l, r)]]]);
    }
    const n2 = after[1];
    if (n && n2 && n2.x0 > n.x1) {
      const x0 = n.x0 - (n2.x0 - n.x1) - w;
      out.push([x0, [[x0 + w, n.x0, mid(r, n)], [n.x1, n2.x0, mid(n, n2)]]]);
    }
    return out.map(([x0, gaps]): [number, [Gap, Gap]] => [x0 - r.x0, gaps]).filter(([d]) => Number.isFinite(d));
  }

  private equalSpacing(r: Rect, threshold: number, horizontal: boolean): number | null {
    let best: number | null = null;
    for (const [d] of this.spacings(r, horizontal)) if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    return best;
  }

  private spacingGuides(r: Rect, horizontal: boolean): Guide[] {
    const out: Guide[] = [];
    for (const [d, gaps] of this.spacings(r, horizontal)) {
      if (Math.abs(d) >= 1e-6) continue;
      for (const [from, to, across] of gaps) {
        const g: Guide = horizontal ? { x0: from, y0: across, x1: to, y1: across, label: label(to - from) } : { x0: across, y0: from, x1: across, y1: to, label: label(to - from) };
        if (!out.some((o) => o.x0 === g.x0 && o.y0 === g.y0 && o.x1 === g.x1 && o.y1 === g.y1)) out.push(g);
      }
    }
    return out;
  }
}
