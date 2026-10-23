import createDOMPurify from "dompurify";

// The design file as the canvas holds it: a detached element whose children are the artboards (elements with data-board),
// with every layer carrying a unique data-nid. The canvas edits this tree and writes it back as text.
//
// A design file can come from anyone, so it is cleaned before it is ever put in the page (parseDesign): no scripts, styles,
// frames, forms, event handlers, outside pictures or url() in styles. The host's app refuses such files too (designUnsafe in
// @mc/shared); this is the second wall, and the reason the canvas can draw a design in the app's own page.

export const DESIGN_HEADER = "<!-- Nido design. Open it in Nido's design mode. -->";

const FORBID_TAGS = ["script", "style", "iframe", "frame", "frameset", "form", "object", "embed", "applet", "link", "meta", "base", "template", "noscript", "portal", "dialog", "use", "image", "feimage", "foreignobject", "animate", "animatemotion", "animatetransform", "set", "audio", "video", "source", "track"];
const FORBID_ATTR = ["srcset", "action", "formaction", "ping", "background", "poster", "xlink:href", "target", "autofocus"];
const PICTURE = /^data:image\/(png|jpe?g|gif|webp);/i;

/** An inline style's declarations in order, split at the semicolons that end them (not those inside url(...) or quotes). */
export function parseStyle(style: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const push = (end: number) => {
    const decl = style.slice(start, end);
    const colon = decl.indexOf(":");
    if (colon > 0) {
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const value = decl.slice(colon + 1).trim();
      if (prop && value) out.push([prop, value]);
    }
    start = end + 1;
  };
  for (let i = 0; i < style.length; i++) {
    const c = style[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) push(i);
  }
  push(style.length);
  return out;
}

export const writeStyle = (decls: [string, string][]) => decls.map(([k, v]) => `${k}: ${v}`).join("; ");

/** One declaration of an element's inline style as written ("#f0c", not the browser's "rgb(255, 0, 204)"), or "". */
export function styleGet(el: Element, prop: string): string {
  const k = prop.toLowerCase();
  return parseStyle(el.getAttribute("style") ?? "").findLast(([p]) => p === k)?.[1] ?? "";
}

/**
 * Changes some declarations of an element's inline style and keeps the rest as written (the browser's style object would
 * rewrite every colour and shorthand). null removes a declaration.
 */
export function styleSet(el: Element, changes: Record<string, string | null>) {
  const decls = parseStyle(el.getAttribute("style") ?? "");
  for (const [rawKey, v] of Object.entries(changes)) {
    const k = rawKey.toLowerCase();
    const at = decls.findIndex(([p]) => p === k);
    if (v === null || v.trim() === "") {
      if (at >= 0) decls.splice(at, 1);
    } else if (at >= 0) decls[at] = [k, v.trim()];
    else decls.push([k, v.trim()]);
  }
  const text = cleanStyle(writeStyle(decls));
  if (text) el.setAttribute("style", text);
  else el.removeAttribute("style");
}

/** Takes out of an inline style anything that loads from outside or runs code: url() other than an inline picture, expression(), behaviors, imports. */
export function cleanStyle(style: string): string {
  return writeStyle(
    parseStyle(style).filter(([k, v]) => {
      const d = `${k}:${v}`.toLowerCase();
      if (/expression\s*\(|behavior\s*:|-moz-binding|@import|javascript:|\\/.test(d)) return false;
      for (const m of d.matchAll(/url\s*\(\s*['"]?\s*([^'")\s]*)/g)) if (!PICTURE.test(m[1] ?? "")) return false;
      return true;
    }),
  );
}

type Purifier = ReturnType<typeof createDOMPurify>;
let purifier: Purifier | null = null;
function defaultPurifier(): Purifier {
  // Its own instance, so the hooks below never touch the DOMPurify the HTML preview uses.
  purifier ??= createDOMPurify(window);
  return purifier;
}

function hook(node: Element) {
  const tag = node.nodeName.toLowerCase();
  if (node.hasAttribute("src") && !PICTURE.test(node.getAttribute("src") ?? "")) node.removeAttribute("src");
  if (node.hasAttribute("href")) {
    const href = node.getAttribute("href") ?? "";
    if (tag !== "a" || !/^(#|https?:|mailto:)/i.test(href.trim())) node.removeAttribute("href");
  }
  const style = node.getAttribute("style");
  if (style !== null) {
    const clean = cleanStyle(style);
    if (clean) node.setAttribute("style", clean);
    else node.removeAttribute("style");
  }
}

export type Parsed = {
  root: HTMLElement;
  /** What cleaning took out (element and attribute names), to say so on the canvas. */
  removed: string[];
  /** Ids had to be added or made unique: the file changes on the next save. */
  idsFixed: boolean;
};

/** A detached place to keep the design: nothing in it loads or runs. */
function holder(doc: Document): HTMLElement {
  const inert = doc.implementation.createHTMLDocument("");
  return inert.createElement("div");
}

export function parseDesign(text: string, doc: Document = document, purify: Purifier = defaultPurifier()): Parsed {
  purify.addHook("afterSanitizeAttributes", hook);
  let frag: DocumentFragment;
  try {
    frag = purify.sanitize(text, {
      FORBID_TAGS,
      FORBID_ATTR,
      ALLOW_DATA_ATTR: true,
      ALLOW_ARIA_ATTR: true,
      ADD_ATTR: ["data-board", "data-nid", "data-name", "data-layout", "data-code", "data-built"],
      RETURN_DOM_FRAGMENT: true,
    }) as unknown as DocumentFragment;
  } finally {
    purify.removeHook("afterSanitizeAttributes", hook);
  }
  const removed = [
    ...new Set(
      purify.removed.map((r) => {
        const x = r as { element?: Element; attribute?: Attr | null };
        return x.attribute ? `${x.attribute.name} attribute` : x.element ? `<${x.element.nodeName.toLowerCase()}>` : "content";
      }),
    ),
  ].filter((r) => r !== "<#comment>" && r !== "<#text>");
  const root = holder(doc);
  root.append(root.ownerDocument.importNode(frag, true));
  // Comments are dropped (the header is written again on save).
  const walker = root.ownerDocument.createTreeWalker(root, 0x80 /* NodeFilter.SHOW_COMMENT */);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const c of comments) c.parentNode?.removeChild(c);
  const idsFixed = ensureIds(root);
  return { root, removed, idsFixed };
}

/** The design as file text: the header, then the boards as they are. */
export function serializeDesign(root: HTMLElement): string {
  const body = root.innerHTML.replace(/^\s+/, "").replace(/\s+$/, "");
  return `${DESIGN_HEADER}\n${body}\n`;
}

export const boardsOf = (root: HTMLElement): HTMLElement[] => [...root.children].filter((c): c is HTMLElement => c.hasAttribute("data-board"));
export const nidOf = (el: Element | null | undefined): string | null => el?.getAttribute("data-nid") ?? null;
export const byNid = (root: ParentNode, nid: string): HTMLElement | null => (/^[\w-]{1,40}$/.test(nid) ? root.querySelector<HTMLElement>(`[data-nid="${nid}"]`) : null);
export const isBoard = (el: Element) => el.hasAttribute("data-board") && !!el.parentElement && !el.parentElement.hasAttribute("data-nid");

/** The board an element lives in. */
export function boardOf(el: Element): HTMLElement | null {
  let cur: Element | null = el;
  while (cur && !cur.hasAttribute("data-board")) cur = cur.parentElement;
  return cur as HTMLElement | null;
}

/** Gives every element in a board a data-nid, and makes repeated ones unique. True when anything changed. */
export function ensureIds(root: HTMLElement): boolean {
  const seen = new Set<string>();
  let max = 0;
  const all = [...root.querySelectorAll("*")];
  for (const el of all) {
    const m = /^[a-z]*(\d+)$/i.exec(el.getAttribute("data-nid") ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  let changed = false;
  for (const el of all) {
    const id = el.getAttribute("data-nid");
    if (!id || seen.has(id) || !/^[\w-]{1,40}$/.test(id)) {
      const next = `${el.hasAttribute("data-board") ? "b" : "n"}${++max}`;
      el.setAttribute("data-nid", next);
      seen.add(next);
      changed = true;
    } else seen.add(id);
  }
  return changed;
}

/** A fresh id for a new layer. */
export function newNid(root: HTMLElement): string {
  let max = 0;
  for (const el of root.querySelectorAll("[data-nid]")) {
    const m = /(\d+)$/.exec(el.getAttribute("data-nid") ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `n${max + 1}`;
}

/** Gives a copied subtree new ids (so a duplicate never shares ids with what it copies). */
export function renumber(root: HTMLElement, el: Element) {
  let n = Number(/(\d+)$/.exec(newNid(root))?.[1] ?? 1);
  for (const x of [el, ...el.querySelectorAll("[data-nid]")]) x.setAttribute("data-nid", `n${n++}`);
}

const INLINE = new Set(["b", "strong", "i", "em", "u", "s", "span", "br", "small", "mark", "code", "sub", "sup"]);
/** Text you edit in place: no child elements other than inline formatting, and some text or nothing at all. */
export function isTextLayer(el: Element): boolean {
  const tag = el.nodeName.toLowerCase();
  if (["img", "input", "textarea", "select", "hr", "svg"].includes(tag)) return false;
  return [...el.children].every((c) => INLINE.has(c.nodeName.toLowerCase()) && c.children.length === 0) && (el.textContent ?? "").trim().length > 0;
}

/** How an element lays out its children. */
export type Layout = "row" | "column" | "grid" | "free" | "flow";
export function layoutOf(el: HTMLElement): Layout {
  if (el.getAttribute("data-layout") === "free") return "free";
  const d = el.style.display;
  if (d === "grid" || d === "inline-grid") return "grid";
  if (d === "flex" || d === "inline-flex") return el.style.flexDirection.startsWith("column") ? "column" : "row";
  return "flow";
}
export const isStack = (l: Layout) => l === "row" || l === "column" || l === "grid";

/** Whether an element can hold other layers (as opposed to text, pictures and form fields). */
export function isContainer(el: Element): boolean {
  const tag = el.nodeName.toLowerCase();
  if (["img", "input", "textarea", "select", "hr", "br", "svg", "p", "h1", "h2", "h3", "h4", "h5", "h6", "span", "label", "a", "button"].includes(tag)) return el.children.length > 0 && !isTextLayer(el);
  return !isTextLayer(el);
}

/** What the layers list and chips call an element: its data-name, or something from what it is. */
export function layerName(el: Element): string {
  const named = el.getAttribute("data-name") ?? el.getAttribute("data-board");
  if (named) return named.slice(0, 60);
  const tag = el.nodeName.toLowerCase();
  if (tag === "img") return "Image";
  if (tag === "input" || tag === "textarea" || tag === "select") return "Field";
  if (isTextLayer(el)) {
    const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    return t.length > 28 ? `${t.slice(0, 27)}…` : t;
  }
  if (tag === "button" || tag === "a") return "Button";
  const l = "style" in el ? layoutOf(el as HTMLElement) : "flow";
  return isStack(l) ? "Stack" : el.children.length ? "Frame" : "Box";
}

/** "Hero › Button": the element's name with its parent's, for chips. */
export function layerPath(el: Element): string {
  const parent = el.parentElement;
  const own = layerName(el);
  return parent && parent.hasAttribute("data-nid") && !parent.hasAttribute("data-board") ? `${layerName(parent)} › ${own}` : own;
}

export type BoardBox = { x: number; y: number; w: number; h: number | null };
export function boardBox(el: Element): BoardBox {
  const num = (k: string, d: number) => {
    const v = Number(el.getAttribute(k));
    return Number.isFinite(v) ? v : d;
  };
  const h = el.getAttribute("data-h");
  return { x: num("data-x", 0), y: num("data-y", 0), w: Math.min(8000, Math.max(40, num("data-w", 1440))), h: h !== null && Number.isFinite(Number(h)) ? Math.min(20000, Math.max(40, Number(h))) : null };
}

/** A short hash of a board's content, without its place on the canvas and its code link: changes when the design of the board changes. */
export function boardHash(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const a of ["data-x", "data-y", "data-code", "data-built"]) copy.removeAttribute(a);
  const s = copy.outerHTML.replace(/\s+/g, " ");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** What a layer looks like, compared before and after an AI change to flash what changed. */
export function layerSignature(el: Element): string {
  const own = [...el.attributes].map((a) => `${a.name}=${a.value}`).join(" ");
  const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
  return `${el.nodeName}|${own}|${text}|${el.children.length}`;
}

/** Layers that are new or changed in `next` compared with `prev`. */
export function changedLayers(prev: HTMLElement, next: HTMLElement): string[] {
  const before = new Map<string, string>();
  for (const el of prev.querySelectorAll("[data-nid]")) before.set(el.getAttribute("data-nid")!, layerSignature(el));
  const out: string[] = [];
  for (const el of next.querySelectorAll("[data-nid]")) {
    const id = el.getAttribute("data-nid")!;
    if (before.get(id) !== layerSignature(el)) out.push(id);
  }
  return out;
}

/** Indents a newly inserted layer like its siblings, so the file stays one element per line. */
export function insertWithNewline(parent: Element, el: Element, before: Node | null) {
  const doc = parent.ownerDocument;
  let depth = 0;
  for (let p: Element | null = parent; p && p.hasAttribute("data-nid"); p = p.parentElement) depth++;
  parent.insertBefore(doc.createTextNode(`\n${"  ".repeat(depth)}`), before);
  parent.insertBefore(el, before);
  if (!before || before.nodeType !== 3) parent.insertBefore(doc.createTextNode(`\n${"  ".repeat(Math.max(0, depth - 1))}`), before);
}

/** Removes a layer and the whitespace line it sat on. */
export function removeLayer(el: Element) {
  const prev = el.previousSibling;
  if (prev && prev.nodeType === 3 && /^\s*$/.test(prev.textContent ?? "")) prev.parentNode?.removeChild(prev);
  el.remove();
}
