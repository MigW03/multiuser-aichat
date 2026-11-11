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
      ADD_ATTR: ["data-board", "data-nid", "data-name", "data-layout", "data-code", "data-built", "data-page", "data-page-def"],
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

/** Every board in the design, on all pages. */
export const allBoardsOf = (root: HTMLElement): HTMLElement[] => [...root.children].filter((c): c is HTMLElement => c.hasAttribute("data-board"));

// ---- pages
// A design has pages like a Figma file. Each board names its page in `data-page`; the pages' order (and pages with no
// boards) live in hidden top-level elements `<div data-page-def="Name" hidden>`, one per page. A board with no data-page
// is on the first page, so a design made before pages existed has one page, "Page 1".

export const PAGE_LIMITS = { count: 30, name: 40 } as const;
const FIRST_PAGE = "Page 1";
const PAGE_DEF = "data-page-def";
const defsOf = (root: HTMLElement): HTMLElement[] => [...root.children].filter((c): c is HTMLElement => c.hasAttribute(PAGE_DEF));

/** A page name as it is kept: one line, no control characters, at most 40 characters. */
export const cleanPageName = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, PAGE_LIMITS.name).trim();

/** The pages, in order. Always at least one. */
export function pagesOf(root: HTMLElement): string[] {
  const names: string[] = [];
  const add = (n: string) => {
    const c = cleanPageName(n);
    if (c && !names.includes(c)) names.push(c);
  };
  for (const d of defsOf(root)) add(d.getAttribute(PAGE_DEF) ?? "");
  const boards = allBoardsOf(root);
  if (!names.length && (!boards.length || boards.some((b) => !cleanPageName(b.getAttribute("data-page") ?? "")))) names.push(FIRST_PAGE);
  for (const b of boards) add(b.getAttribute("data-page") ?? "");
  return names.length ? names : [FIRST_PAGE];
}

/** The page a board is on. */
export const pageOfBoard = (root: HTMLElement, board: Element, pages: string[] = pagesOf(root)): string => cleanPageName(board.getAttribute("data-page") ?? "") || pages[0]!;

/** The page of the board a layer (or board) lives in. */
export function pageOfNid(root: HTMLElement, nid: string): string | null {
  const el = byNid(root, nid);
  const board = el ? boardOf(el) : null;
  return board ? pageOfBoard(root, board) : null;
}

// The page the canvas shows is kept beside the design, not in it: the file holds no "current page".
const viewPages = new WeakMap<HTMLElement, string>();
export function setViewPage(root: HTMLElement, page: string) {
  viewPages.set(root, page);
}
/** The page being shown (the first one when the chosen page is gone). */
export function viewPageOf(root: HTMLElement, pages: string[] = pagesOf(root)): string {
  const v = viewPages.get(root);
  return v !== undefined && pages.includes(v) ? v : pages[0]!;
}

/** The boards of the page being shown. Everything on the canvas and in the layers list works on these. */
export function boardsOf(root: HTMLElement): HTMLElement[] {
  const pages = pagesOf(root);
  const view = viewPageOf(root, pages);
  return allBoardsOf(root).filter((b) => pageOfBoard(root, b, pages) === view);
}

/** How many boards each page has. */
export function pageCounts(root: HTMLElement): Map<string, number> {
  const pages = pagesOf(root);
  const counts = new Map(pages.map((p) => [p, 0]));
  for (const b of allBoardsOf(root)) {
    const p = pageOfBoard(root, b, pages);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return counts;
}

/** Writes the page list: every board names its page, and the hidden page elements are written again in order. */
function writePages(root: HTMLElement, names: string[]) {
  const pages = pagesOf(root);
  for (const b of allBoardsOf(root)) b.setAttribute("data-page", pageOfBoard(root, b, pages));
  for (const d of defsOf(root)) removeLayer(d);
  const doc = root.ownerDocument;
  const frag = doc.createDocumentFragment();
  for (const n of names) {
    const d = doc.createElement("div");
    d.setAttribute(PAGE_DEF, n);
    d.setAttribute("hidden", "");
    frag.append(d, doc.createTextNode("\n"));
  }
  root.prepend(frag);
}

/** A page name nobody has: the wish, or "Page 3", with a number added when taken. */
export function uniquePageName(root: HTMLElement, wish = ""): string {
  const pages = pagesOf(root);
  const base = cleanPageName(wish) || `Page ${pages.length + 1}`;
  if (!pages.includes(base)) return base;
  for (let n = 2; ; n++) {
    const next = `${base.slice(0, PAGE_LIMITS.name - 4)} ${n}`;
    if (!pages.includes(next)) return next;
  }
}

/** Adds an empty page at the end. Returns its name, or null at the limit. */
export function addPage(root: HTMLElement, wish = ""): string | null {
  const pages = pagesOf(root);
  if (pages.length >= PAGE_LIMITS.count) return null;
  const name = uniquePageName(root, wish);
  writePages(root, [...pages, name]);
  return name;
}

/** Renames a page (its boards follow). Returns the new name, or null when it is empty or taken. */
export function renamePage(root: HTMLElement, from: string, wish: string): string | null {
  const name = cleanPageName(wish);
  const pages = pagesOf(root);
  if (!name || !pages.includes(from) || (name !== from && pages.includes(name))) return null;
  writePages(root, pages);
  for (const b of allBoardsOf(root)) if (b.getAttribute("data-page") === from) b.setAttribute("data-page", name);
  writePages(root, pages.map((p) => (p === from ? name : p)));
  return name;
}

/** Deletes a page and its boards. False for the last page. */
export function deletePage(root: HTMLElement, name: string): boolean {
  const pages = pagesOf(root);
  if (pages.length < 2 || !pages.includes(name)) return false;
  writePages(root, pages);
  for (const b of allBoardsOf(root)) if (b.getAttribute("data-page") === name) removeLayer(b);
  writePages(root, pages.filter((p) => p !== name));
  return true;
}

/** Copies a page with its boards (new layer ids) to the end of the list. Returns the copy's name. */
export function duplicatePage(root: HTMLElement, name: string): string | null {
  const pages = pagesOf(root);
  if (!pages.includes(name) || pages.length >= PAGE_LIMITS.count) return null;
  writePages(root, pages);
  const copy = uniquePageName(root, `${name} copy`);
  for (const b of allBoardsOf(root).filter((x) => x.getAttribute("data-page") === name)) {
    const clone = b.cloneNode(true) as HTMLElement;
    renumber(root, clone);
    clone.setAttribute("data-page", copy);
    clone.setAttribute("data-board", uniqueBoardName(root, b.getAttribute("data-board") ?? "Board"));
    root.append(root.ownerDocument.createTextNode("\n"), clone);
  }
  writePages(root, [...pages, copy]);
  return copy;
}

/** A board name nobody has: the name, or "Home 2" when taken. Boards on different pages are told apart by name when building code. */
export function uniqueBoardName(root: HTMLElement, wish: string): string {
  const taken = new Set(allBoardsOf(root).map((b) => b.getAttribute("data-board")));
  const base = wish.trim().slice(0, 56) || "Board";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** Adds an empty board to the page being shown. Returns its layer id. */
export function createBoard(root: HTMLElement, box: { x: number; y: number; w: number; h: number }): string {
  const doc = root.ownerDocument;
  const b = doc.createElement("section");
  const nid = newNid(root);
  b.setAttribute("data-board", uniqueBoardName(root, `Board ${allBoardsOf(root).length + 1}`));
  b.setAttribute("data-nid", nid);
  b.setAttribute("data-page", viewPageOf(root));
  b.setAttribute("data-x", String(Math.round(box.x)));
  b.setAttribute("data-y", String(Math.round(box.y)));
  b.setAttribute("data-w", String(box.w));
  b.setAttribute("data-h", String(box.h));
  b.setAttribute("style", "display: flex; flex-direction: column; gap: 24px; padding: 48px; background: #ffffff; color: #111111");
  root.append(doc.createTextNode("\n"), b, doc.createTextNode("\n"));
  return nid;
}

/** Moves a page to a place in the list (0 = first). False when nothing changed. */
export function movePage(root: HTMLElement, name: string, to: number): boolean {
  const pages = pagesOf(root);
  const from = pages.indexOf(name);
  const at = Math.max(0, Math.min(pages.length - 1, to));
  if (from < 0 || from === at) return false;
  const next = pages.filter((p) => p !== name);
  next.splice(at, 0, name);
  writePages(root, next);
  return true;
}

/** Moves boards (by their ids) to another page, placed in a row to the right of what is there. Returns how many moved. */
export function moveBoardsToPage(root: HTMLElement, nids: string[], page: string): number {
  const pages = pagesOf(root);
  if (!pages.includes(page)) return 0;
  const moving = allBoardsOf(root).filter((b) => nids.includes(nidOf(b) ?? "") && pageOfBoard(root, b, pages) !== page);
  if (!moving.length) return 0;
  const there = allBoardsOf(root).filter((b) => pageOfBoard(root, b, pages) === page);
  const boxes = moving.map((b) => boardBox(b));
  const fromX = Math.min(...boxes.map((b) => b.x));
  const fromY = Math.min(...boxes.map((b) => b.y));
  const baseX = there.length ? Math.max(...there.map((b) => boardBox(b).x + boardBox(b).w)) + 80 : 0;
  const baseY = there.length ? Math.min(...there.map((b) => boardBox(b).y)) : 0;
  writePages(root, pages);
  moving.forEach((b, i) => {
    b.setAttribute("data-x", String(Math.round(baseX + boxes[i]!.x - fromX)));
    b.setAttribute("data-y", String(Math.round(baseY + boxes[i]!.y - fromY)));
    b.setAttribute("data-page", page);
  });
  return moving.length;
}
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
  const all = [...root.querySelectorAll("*")].filter((el) => !el.hasAttribute(PAGE_DEF));
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
