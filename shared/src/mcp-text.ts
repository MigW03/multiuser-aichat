import { MCP_LIMITS as M } from "./mcp-limits.ts";
import type { McpCallResult } from "./index.ts";

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

const MAX_TOOLS_LISTED = 200;
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
  const cleaned = redactSecrets(cleanOutput(parts.join("\n")));
  const truncated = cleaned.length > M.resultChars;
  return { text: truncated ? cleaned.slice(0, M.resultChars) : cleaned, isError: r.isError === true, truncated };
}

const safeJson = (v: unknown) => {
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return "";
  }
};

