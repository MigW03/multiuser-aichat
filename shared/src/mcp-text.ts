import { MCP_LIMITS as M } from "./mcp-limits.ts";
import type { McpCallResult, McpFile } from "./index.ts";

// Plain-text cleaning shared by everything that handles text written by someone else: what a command or an MCP tool
// prints, and what an MCP server says about its tools. Used by the desktop app (local tools, commands, files) and by the
// chat server (remote MCP servers), so both clean the same way.

/** Token formats that must never reach a chat, even from a file that is shown. Best effort: the names above are the real barrier. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI, Anthropic (sk-ant-...), OpenRouter (sk-or-...)
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bsb_secret_[A-Za-z0-9_-]{16,}/g, // Supabase
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JSON web tokens (Supabase keys among them)
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted secret]");
  return out;
}


/** Removes terminal escape sequences and control characters other than line breaks and tabs. */
export function cleanOutput(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI sequences (colors, cursor moves)
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "") // OSC sequences (titles, links)
      .replaceAll("\r\n", "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/\r(?!\n)/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, "")
  );
}


const TOOL_NAME = new RegExp(`^[A-Za-z0-9_.-]{1,${M.toolNameChars}}$`);
/** A tool as reported to the person. `usable` is false when it can't be offered to the AI (odd name, huge schema). */
export type ToolEntry = { name: string; description: string; inputSchema: Record<string, unknown>; usable: boolean; note?: string };

const MAX_TOOLS_LISTED = 400;
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** Turns what `tools/list` returned into entries, dropping or flagging what can't be used. */
export function toolEntries(raw: unknown[]): ToolEntry[] {
  const seen = new Set<string>();
  const out: ToolEntry[] = [];
  for (const t of raw.slice(0, MAX_TOOLS_LISTED)) {
    const r = (t ?? {}) as { name?: unknown; description?: unknown; inputSchema?: unknown };
    if (typeof r.name !== "string" || seen.has(r.name)) continue;
    seen.add(r.name);
    const description = typeof r.description === "string" ? clip(oneLine(r.description), M.descriptionChars) : "";
    const schema = r.inputSchema && typeof r.inputSchema === "object" && !Array.isArray(r.inputSchema) ? (r.inputSchema as Record<string, unknown>) : null;
    let note: string | undefined;
    if (!TOOL_NAME.test(r.name)) note = "Its name has characters the AI can't use.";
    else if (!schema) note = "It does not describe its inputs.";
    else if (JSON.stringify(schema).length > M.schemaChars) note = "Its input description is too large.";
    out.push({ name: clip(r.name, M.toolNameChars), description, inputSchema: note ? {} : schema!, usable: !note, ...(note ? { note } : {}) });
  }
  return out;
}

/** A tool's answer as plain text: what it returned, minus anything binary, with secrets masked, cut to the size limit. */
export function resultText(result: unknown): McpCallResult {
  const r = (result ?? {}) as { content?: unknown; structuredContent?: unknown; isError?: unknown; toolResult?: unknown };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const c of r.content as { type?: unknown; text?: unknown; mimeType?: unknown; data?: unknown; resource?: { uri?: unknown; text?: unknown }; uri?: unknown; name?: unknown }[]) {
      if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
      else if (c?.type === "image" || c?.type === "audio") parts.push(`[${String(c.type)} omitted${typeof c.mimeType === "string" ? `: ${clip(oneLine(c.mimeType), 40)}` : ""}]`);
      else if (c?.type === "resource" && c.resource) parts.push(typeof c.resource.text === "string" ? c.resource.text : `[binary resource omitted: ${clip(oneLine(String(c.resource.uri ?? "")), 200)}]`);
      else if (c?.type === "resource_link") parts.push(`[link: ${clip(oneLine(String(c.name ?? "")), 100)} ${clip(oneLine(String(c.uri ?? "")), 300)}]`);
    }
  }
  if (parts.length === 0 && r.structuredContent !== undefined) parts.push(safeJson(r.structuredContent));
  else if (parts.length === 0 && r.toolResult !== undefined) parts.push(safeJson(r.toolResult));
  const { text: shown, links } = hideSignedLinks(cleanOutput(parts.join("\n")));
  const cleaned = redactSecrets(shown);
  const truncated = cleaned.length > M.resultChars;
  return { text: truncated ? cleaned.slice(0, M.resultChars) : cleaned, isError: r.isError === true, truncated, ...(links.length ? { links } : {}) };
}

// ---- Download links in a tool's answer. A signed address (ClickUp, S3, Google) holds a token that looks like a secret, so
// masking would cut it in the middle and leave a link nobody can open. Such an address is shown as [link:<id> host/path] with the
// token left out; the id is a short hash the chat server can map back to the whole address (it keeps the raw list in `links`).

const LINK = /https:\/\/[^\s"'<>\\\])}]+/g;
const MAX_LINKS = 20;
const MAX_LINK_CHARS = 4_000;

/** A short, stable name for an address: 8 hex characters. Not a secret and not a security check, only a handle. */
export function linkHandle(url: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < url.length; i++) {
    a = Math.imul(a ^ url.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b + url.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0").slice(0, 4) + b.toString(16).padStart(8, "0").slice(0, 4);
}

function hideSignedLinks(text: string): { text: string; links: string[] } {
  const links: string[] = [];
  const out = text.replace(LINK, (m) => {
    const url = m.replace(/[.,;:!?]+$/, "");
    const tail = m.slice(url.length);
    if (url.length > MAX_LINK_CHARS) return m;
    if (!links.includes(url) && links.length < MAX_LINKS) links.push(url);
    if (redactSecrets(url) === url) return m;
    let where = "";
    try {
      const u = new URL(url);
      where = ` ${u.host}${u.pathname}`.slice(0, 200);
    } catch {
      /* the handle alone is enough */
    }
    return `[link:${linkHandle(url)}${where}]${tail}`;
  });
  return { text: out, links };
}

/** Largest file, and the most one answer may carry in all (base64 characters): the chat server holds them in memory while it stores them. */
const FILE_MAX_BASE64 = 36 * 1024 * 1024;
const FILES_MAX = 5;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "application/pdf": "pdf", "audio/mpeg": "mp3", "audio/wav": "wav", "text/plain": "txt", "text/html": "html", "text/csv": "csv", "application/json": "json" };

/** The real files in a tool's answer: pictures, audio and binary resources (base64). Text is not a file; resultText has it. */
export function resultFiles(result: unknown): McpFile[] {
  const r = (result ?? {}) as { content?: unknown };
  if (!Array.isArray(r.content)) return [];
  const files: McpFile[] = [];
  let n = 0;
  let total = 0;
  for (const c of r.content as { type?: unknown; data?: unknown; mimeType?: unknown; resource?: { uri?: unknown; blob?: unknown; mimeType?: unknown } }[]) {
    if (files.length >= FILES_MAX) break;
    n += 1;
    const inline = (c?.type === "image" || c?.type === "audio") && typeof c.data === "string" ? c : null;
    const res = c?.type === "resource" && typeof c.resource?.blob === "string" ? c.resource : null;
    const data = inline ? (inline.data as string) : res ? (res.blob as string) : null;
    if (!data || data.length > FILE_MAX_BASE64 || total + data.length > FILE_MAX_BASE64) continue;
    total += data.length;
    const mimeType = clip(oneLine(String((inline ? inline.mimeType : res?.mimeType) ?? "application/octet-stream")), 100);
    const fromUri = res && typeof res.uri === "string" ? decodeSafe(res.uri.split(/[?#]/)[0]!.split("/").pop() ?? "") : "";
    files.push({ name: fromUri || `${String(c.type)}-${n}.${EXT[mimeType.toLowerCase()] ?? "bin"}`, mimeType, data });
  }
  return files;
}

const decodeSafe = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const safeJson = (v: unknown) => {
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return "";
  }
};

