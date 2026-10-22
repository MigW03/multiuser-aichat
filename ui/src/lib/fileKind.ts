// What the file panel needs to know about a shared file's path: how to show it, whether a piece of text in an answer looks like
// one, which paths to try for it, and where a relative link inside a Markdown file points.

export type FileKind = "markdown" | "html" | "text";

const MARKDOWN = new Set(["md", "markdown", "mdown", "mkd"]);
const HTML = new Set(["html", "htm"]);

const extensionOf = (path: string): string => {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** Markdown and HTML files get a Preview; everything else is shown as text. */
export function fileKind(path: string): FileKind {
  const ext = extensionOf(path);
  return MARKDOWN.has(ext) ? "markdown" : HTML.has(ext) ? "html" : "text";
}

/** Extensions of files a person would open to read: text, code, data. Pictures and other binaries are refused by the host anyway. */
const READABLE = new Set([
  ...MARKDOWN,
  ...HTML,
  "txt", "json", "jsonc", "yml", "yaml", "toml", "xml", "csv", "tsv", "sql", "ini", "cfg", "conf", "log", "lock",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "css", "scss", "less", "vue", "svelte",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "ps1", "bat",
]);

// Library names that end in .js or .ts but are not files ("Next.js", "node.js").
const NOT_FILES = new Set(["node.js", "next.js", "nuxt.js", "vue.js", "react.js", "three.js", "d3.js", "chart.js", "express.js", "alpine.js", "deno.ts", "bun.ts"]);

/** Whether text written as `code` in an answer reads as the path of a file, like `README.md` or `src/app/index.html`. */
export function looksLikeFilePath(text: string): boolean {
  if (text.length === 0 || text.length > 200) return false;
  if (!/^(?:\.{1,2}\/)?[\w@+-][\w@.+-]*(?:\/[\w@.+-]+)*$/.test(text)) return false;
  const path = text.replace(/^\.\//, "");
  if (path.split("/").some((part) => part === ".." || part === ".")) return false;
  if (!READABLE.has(extensionOf(path))) return false;
  return !NOT_FILES.has(path.toLowerCase());
}

/** A path as the shared folder knows it: no leading "./" or "/", one slash between parts. */
export const cleanPath = (raw: string): string =>
  raw
    .trim()
    .replace(/^(?:\.\/|\/)+/, "")
    .replace(/\/{2,}/g, "/");

/**
 * Where to look for a file named in an answer. Shared paths start with the name of the shared folder, but an answer usually
 * names the file from inside the project, so the path is tried as written first and then under each shared folder.
 */
export function candidatePaths(raw: string, folders: string[]): string[] {
  const path = cleanPath(raw);
  if (!path) return [];
  const all = [path, ...folders.filter((f) => !path.startsWith(`${f}/`)).map((f) => `${f}/${path}`)];
  return [...new Set(all)];
}

/**
 * The path a relative link in a file points to, from the folder that file is in. null: not a link to another file (an
 * address, an anchor, a mail link) or one that leaves the shared folders.
 */
export function resolveRelative(fromDir: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#") || href === "") return null;
  const target = href.replace(/[?#].*$/, "");
  if (target === "") return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null;
  }
  // The first part of a path is the shared folder's name: a link starting with "/" begins inside it, and none may climb above it.
  const from = fromDir.split("/").filter(Boolean);
  const parts: string[] = decoded.startsWith("/") ? from.slice(0, 1) : from;
  for (const part of decoded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length <= 1) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length >= 1 ? parts.join("/") : null;
}

export const dirOf = (path: string): string => path.split("/").slice(0, -1).join("/");

/** File paths an answer writes as `code`, once each, in order. */
export function findFilePaths(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?<!`)`([^`\n]{1,200})`(?!`)/g)) {
    const raw = m[1]!.trim();
    if (looksLikeFilePath(raw)) found.add(cleanPath(raw));
  }
  return [...found];
}
