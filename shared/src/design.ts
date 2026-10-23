// Design mode: a design is one HTML document that belongs to a project (not to anyone's folder). Each top-level element
// with `data-board` is an artboard on the canvas; every layer carries a stable `data-nid`. It is plain HTML with inline
// styles, so people edit it on the canvas, the AI edits it with its design tools, and code is built from it.
//
// The server keeps a project's designs: the list and versions in the database, the HTML in the object store (R2). A design
// is addressed as `project:<slug>.design.html`. Older designs may still be files in a shared folder (`*.design.html`);
// those open read-only, with a button that copies them into the project.
//
// Designs come from anyone in a project, so they never run code: the server refuses to save one that holds scripts or
// other active content (designUnsafe), and the page cleans what it shows again before drawing it.

export const DESIGN_LIMITS = {
  /** Longest design file, in characters. Room for many boards; well inside the relay's 1 MB frames. */
  chars: 400_000,
  /** Longest edit summary or board list carried in a chat marker. */
  markerChars: 600,
  /** Longest design name. */
  nameChars: 60,
  /** Designs in one project. */
  perProject: 200,
  /** Saved versions kept for each design (older ones are dropped). */
  versions: 50,
} as const;

export const DESIGN_SUFFIX = ".design.html";
/** How a project's own designs are addressed: `project:landing-page.design.html`. A shared folder's paths never hold ":". */
export const PROJECT_DESIGN_PREFIX = "project:";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The address of a project design. */
export const projectDesignPath = (slug: string) => `${PROJECT_DESIGN_PREFIX}${slug}${DESIGN_SUFFIX}`;

/** The slug of a project design's address, or null when it is not one (a shared folder's file, or not valid). */
export function projectDesignSlug(path: unknown): string | null {
  if (typeof path !== "string" || !path.startsWith(PROJECT_DESIGN_PREFIX) || !path.endsWith(DESIGN_SUFFIX)) return null;
  const slug = path.slice(PROJECT_DESIGN_PREFIX.length, path.length - DESIGN_SUFFIX.length);
  return slug.length <= DESIGN_LIMITS.nameChars && SLUG.test(slug) ? slug : null;
}

export const isProjectDesignPath = (path: unknown): boolean => projectDesignSlug(path) !== null;

/** Whether a path names a design file. Paths with characters the chat marker uses are not allowed. */
export function isDesignPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 400) return false;
  if (/["⟦⟧\n\r\\]/.test(path)) return false;
  const last = path.split("/").filter(Boolean).at(-1) ?? "";
  return last.length > DESIGN_SUFFIX.length && last.toLowerCase().endsWith(DESIGN_SUFFIX);
}

/** "designs/landing-page.design.html" and "project:landing-page.design.html" -> "landing-page". */
export function designName(path: string): string {
  const unprefixed = path.startsWith(PROJECT_DESIGN_PREFIX) ? path.slice(PROJECT_DESIGN_PREFIX.length) : path;
  const last = unprefixed.split("/").filter(Boolean).at(-1) ?? unprefixed;
  return last.slice(0, Math.max(0, last.length - DESIGN_SUFFIX.length)) || last;
}

/** A file name for a new design: lower case words joined by "-". */
export function designSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, DESIGN_LIMITS.nameChars)
    .replace(/-+$/g, "");
  return slug || "design";
}

// Active content a design must never hold. Checked as text by the server before anything is saved, so a design stays
// harmless even when someone opens it straight in a browser. Attribute values are read the way a browser
// reads them (character references decoded, tabs and line breaks in a URL scheme ignored).
const BAD_TAG: [RegExp, string][] = [
  [/<\s*\/?\s*(script|iframe|frame|frameset|object|embed|applet|link|meta|base|form|style|template|noscript|portal)\b/i, "a <$1> element"],
  [/<\s*\/?\s*(use|image|feimage|foreignobject|animate\w*|set|handler|listener)\b/i, "an SVG <$1> element"],
];
const BAD_ATTR = new Set(["srcset", "formaction", "action", "ping", "background", "poster", "dynsrc", "lowsrc", "xlink:href", "srcdoc"]);
const PICTURE_URL = /^data:image\/(png|jpe?g|gif|webp)[;,]/i;
const TAG = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const NAMED: Record<string, string> = { colon: ":", lpar: "(", rpar: ")", sol: "/", bsol: "\\", quot: '"', apos: "'", amp: "&", tab: "\t", newline: "\n", nbsp: " ", semi: ";", comma: ",", period: ".", excl: "!", num: "#", lowbar: "_", equals: "=" };

/** An attribute value as a browser reads it: character references decoded ("&#106;avascript&colon;" is "javascript:"). */
function decodeRefs(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (all, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return NAMED[ref.toLowerCase()] ?? all;
  });
}

/** Why a style value may not be in a design, or null. */
function badStyle(style: string): string | null {
  const s = style.toLowerCase();
  if (s.includes("\\")) return "a backslash in a style";
  if (/expression\s*\(|behavior\s*:|-moz-binding|@import/.test(s)) return "a CSS expression, behavior or @import";
  for (const m of s.matchAll(/url\s*\(\s*['"]?\s*([^'")\s]*)/g)) if (!PICTURE_URL.test(m[1] ?? "")) return "a CSS url() that is not an inline picture";
  return null;
}

/** Why a design's text may not be written, or null when it is fine. */
export function designUnsafe(html: string): string | null {
  for (const [re, what] of BAD_TAG) {
    const m = re.exec(html);
    if (m) return what.replace("$1", (m[1] ?? "").toLowerCase());
  }
  for (const tag of html.matchAll(TAG)) {
    for (const a of (tag[2] ?? "").matchAll(ATTR)) {
      const name = (a[1] ?? "").toLowerCase();
      const raw = a[2] ?? a[3] ?? a[4] ?? "";
      const value = decodeRefs(raw);
      const compact = value.replace(/[\u0000-\u0020]/g, "").toLowerCase();
      if (name.startsWith("on")) return "an event handler attribute (on...)";
      if (BAD_ATTR.has(name)) return `a ${name} attribute`;
      if (/(java|vb)script:|data:text\/html/.test(compact)) return "a script: address";
      if (name === "src" && !PICTURE_URL.test(value.trim())) return "a src that is not an inline picture";
      if (name === "style") {
        const bad = badStyle(value);
        if (bad) return bad;
      }
    }
  }
  return null;
}

/** The text a new, empty design starts with: one desktop board laid out as a stack. */
export function emptyDesign(board: "desktop" | "phone" = "desktop"): string {
  const w = board === "phone" ? 390 : 1440;
  const h = board === "phone" ? 844 : 900;
  return `<!-- Nido design. Open it in Nido's design mode. -->
<section data-board="${board === "phone" ? "Phone" : "Desktop"}" data-nid="b1" data-x="0" data-y="0" data-w="${w}" data-h="${h}" style="display: flex; flex-direction: column; gap: 24px; padding: 48px; background: #ffffff; color: #111111; font-family: system-ui, sans-serif">
</section>
`;
}

// ---- The chat marker: a design reference at the start of a message, drawn as a chip. The AI reads it as text.
// ⟦design path="project:a.design.html" sel="n6,n4" names="Hero › Button" edits="..." action="build" boards="Home"⟧

export type DesignAction = "new" | "build" | "update-code";
export type DesignRef = {
  path?: string;
  /** Selected layers' data-nid values. */
  sel?: string[];
  /** What the selected layers are called, for the chip. */
  names?: string;
  /** What people changed on the canvas since the AI's last answer. */
  edits?: string;
  action?: DesignAction;
  boards?: string[];
  /** build: where the code goes (a folder). */
  where?: string;
};

const MARK_OPEN = "⟦design";
const MARK_CLOSE = "⟧";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const attr = (s: string) => s.replace(/["⟦⟧\r\n]+/g, " ").trim();

export function designMarker(ref: DesignRef): string {
  const parts: string[] = [];
  const add = (k: string, v: string | undefined) => v && parts.push(`${k}="${attr(clip(v, DESIGN_LIMITS.markerChars))}"`);
  add("path", ref.path);
  add("sel", ref.sel?.join(","));
  add("names", ref.names);
  add("action", ref.action);
  add("boards", ref.boards?.join(","));
  add("where", ref.where);
  add("edits", ref.edits);
  return `${MARK_OPEN} ${parts.join(" ")}${MARK_CLOSE}`;
}

/** Splits a leading marker off a message. `rest` is the message without it. */
export function parseDesignMarker(text: string): { ref: DesignRef; rest: string } | null {
  if (!text.startsWith(MARK_OPEN)) return null;
  const end = text.indexOf(MARK_CLOSE);
  if (end < 0 || end > 4000) return null;
  const body = text.slice(MARK_OPEN.length, end);
  const ref: DesignRef = {};
  for (const m of body.matchAll(/(\w+)="([^"]*)"/g)) {
    const [, k, v] = m as unknown as [string, string, string];
    if (k === "path" && isDesignPath(v)) ref.path = v;
    else if (k === "sel") ref.sel = v.split(",").filter((x) => /^[\w-]{1,40}$/.test(x)).slice(0, 50);
    else if (k === "names") ref.names = v;
    else if (k === "edits") ref.edits = v;
    else if (k === "action" && (v === "new" || v === "build" || v === "update-code")) ref.action = v;
    else if (k === "boards") ref.boards = v.split(",").map((b) => b.trim()).filter(Boolean).slice(0, 50);
    else if (k === "where") ref.where = v;
  }
  return { ref, rest: text.slice(end + 1).replace(/^\s*\n/, "") };
}

/** Realtime broadcasts on `project:<id>` about designs. Hints only: the canvas re-reads the design to know. */
export type DesignSavedEvent = { path: string; version: number; by: string };
/** The list of designs changed (one was made or deleted). */
export type DesignListEvent = { by: string };
/** The AI is writing a design (`start`) or finished one write (`done`). `chatId`: where its answer is, for Stop. */
/** `seq` grows with every hint the server sends, so a canvas can drop one that arrives after a newer one. */
export type DesignAiEvent = { path: string; state: "start" | "done"; by: string; chatId: string; version?: number; seq?: number };
/** Someone asks the current editor of a design to hand it over, and the editor's answer. */
export type DesignAskEvent = { path: string; from: string; name: string };
export type DesignHandoverEvent = { path: string; from: string; to: string };

/** A project design in the list. `version` grows by one with every save. People are profile ids (null once gone). */
export type ProjectDesign = { path: string; name: string; version: number; bytes: number; createdBy: string | null; updatedBy: string | null; createdAt: string; updatedAt: string };
export type DesignList = { designs: ProjectDesign[] };
/** A design's text, and the version it is, for the next save. */
export type DesignReadResult = { path: string; name: string; text: string; version: number };
export type DesignWriteResult = { path: string; version: number; created: boolean };
/** An older design file in a shared folder, read whole. It opens read-only and can be copied into the project. */
export type FolderDesignResult = { path: string; text: string };
/** One saved version, newest first in a list. */
export type DesignVersion = { version: number; by: string | null; at: string; bytes: number };
export type DesignVersionList = { versions: DesignVersion[]; current: number };

/** A message without its leading design marker, for previews and titles. */
export function stripDesignMarker(text: string): string {
  return parseDesignMarker(text)?.rest ?? text;
}

/** What a marker's chip says: the selected layers, or what is asked, or the design's name. */
export function designChipLabel(ref: DesignRef): string {
  const name = ref.path ? designName(ref.path) : "";
  if (ref.action === "new") return "New design";
  if (ref.action === "build") return `Build in code${ref.boards?.length ? ` · ${ref.boards.join(", ")}` : name ? ` · ${name}` : ""}`;
  if (ref.action === "update-code") return `Update code${ref.boards?.length ? ` · ${ref.boards.join(", ")}` : ""}`;
  if (ref.names) return ref.names;
  return name || "Design";
}
