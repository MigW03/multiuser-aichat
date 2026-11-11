// Skills: saved instructions the AI follows for a task. A skill is text only (a name, a "when to use" line and the
// instructions). A plugin is a bundle of skills installed together from a file. Nothing in a skill or plugin ever runs.
// The checks here are shared: the page uses them to tell people what is wrong before saving, the server uses the same
// ones to decide what is saved.

export const SKILL_LIMITS = {
  /** One name part: lowercase letters, digits and dashes. */
  nameChars: 40,
  descriptionChars: 300,
  bodyChars: 8000,
  /** Skills one person, or one project, can hold in all (plugin skills count). */
  perScope: 60,
  plugins: 10,
  perPlugin: 20,
  /** A plugin file, as uploaded. */
  zipBytes: 1_000_000,
  /** Skills the AI can load in one answer. */
  perAnswer: 3,
  pluginTextChars: 300,
} as const;

const PART = "[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?";
/** A name people type: `release-notes`. */
export const SKILL_NAME_PATTERN = new RegExp(`^${PART}$`);
/** What a skill is called in a list and after "/": a skill of a plugin is `plugin:skill`. */
export const SKILL_FULL_NAME_PATTERN = new RegExp(`^${PART}(?::${PART})?$`);

export type SkillScope = "mine" | "project";

/** A skill as the lists show it. The instructions are fetched one at a time. */
export type SkillItem = {
  id: string;
  /** What is typed after "/": `release-notes`, or `plugin:skill` for a skill of a plugin. */
  name: string;
  description: string;
  /** The AI may pick this skill itself. Off: it runs only when someone types its name after "/". */
  auto_use: boolean;
  enabled: boolean;
  plugin_id: string | null;
  scope: SkillScope;
  /** Who wrote it or installed it (display name), when that person is still here. */
  by: string | null;
  updated_at: string;
};
export type SkillFull = SkillItem & { body: string };

export type PluginItem = {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  enabled: boolean;
  scope: SkillScope;
  by: string | null;
  updated_at: string;
};

export type SkillGroup = { skills: SkillItem[]; plugins: PluginItem[] };
/** `project` is there when a project was asked for and the person is in it. */
export type SkillsList = { mine: SkillGroup; project?: SkillGroup };

export type SkillInput = { name: string; description: string; body: string; auto_use: boolean };

/** What the page shows before a plugin is installed. Nothing has been saved. */
export type PluginPreview = {
  name: string;
  version: string;
  author: string;
  description: string;
  skills: { name: string; description: string; body_chars: number; problem: string | null }[];
  /** Counts of what the file holds that Nido does not run, by kind, for the "left out" line. */
  left_out: { commands: number; mcp: number; hooks: number; scripts: number; other: number };
  /** The same plugin is already installed in the chosen place: its version, and how the skills change. */
  update: { from: string; added: number; changed: number; removed: number } | null;
};

const CONTROL = /[\p{C}\p{Zl}\p{Zp}]/gu;
/** One line of plain text: control characters and line breaks become spaces. */
export const cleanLine = (s: string, max: number): string => s.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max);
/** Text with its line breaks and tabs, and without the characters a database or a prompt tag could be hurt by. */
export const cleanBody = (s: string): string => s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, "");

/** A name made from free text (a SKILL.md `name:`, a folder name): lowercase, dashes between words. Empty when nothing is left. */
export function normalizeSkillName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_LIMITS.nameChars)
    .replace(/-+$/g, "");
}

/** The problem with a skill's fields, in words for the person, or null when they are fine. */
export function skillProblem(input: { name: string; description: string; body: string }): string | null {
  if (!SKILL_NAME_PATTERN.test(input.name)) return "The name can use lowercase letters, digits and dashes (40 characters at most), like release-notes.";
  if (!input.description.trim()) return "Say when to use it: the AI reads this line to decide.";
  if (input.description.length > SKILL_LIMITS.descriptionChars) return `The "when to use it" line can be ${SKILL_LIMITS.descriptionChars} characters at most.`;
  if (!input.body.trim()) return "Add the instructions.";
  if (input.body.length > SKILL_LIMITS.bodyChars) return `The instructions can be ${SKILL_LIMITS.bodyChars.toLocaleString("en-US")} characters at most.`;
  return null;
}

export type ParsedSkillMd = { name: string; description: string; body: string };

const unquote = (v: string): string => {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) return t.slice(1, -1);
  return t;
};

/**
 * Reads a SKILL.md: the frontmatter (`name:` and `description:`, plain, quoted or a `>` / `|` block) and the rest as the
 * instructions. Only those two keys are read; everything else in the frontmatter is ignored. A file with no frontmatter
 * is all instructions. Never throws.
 */
export function parseSkillMd(raw: string): ParsedSkillMd {
  const text = cleanBody(raw).replace(/^﻿/, "");
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { name: "", description: "", body: text.trim() };
  const fields: Record<string, string> = {};
  const lines = m[1]!.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    let value = kv[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      // A block: the indented lines that follow. ">" folds them into one line.
      const folded = value.startsWith(">");
      const parts: string[] = [];
      while (i + 1 < lines.length && /^[ \t]+\S|^\s*$/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      value = parts.filter((p) => p !== "").join(folded ? " " : "\n");
    } else {
      value = unquote(value);
      // A plain value can continue on indented lines.
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1]!)) value += ` ${lines[++i]!.trim()}`;
    }
    if (key === "name" || key === "description") fields[key] = value;
  }
  return { name: fields.name ?? "", description: fields.description ?? "", body: text.slice(m[0].length).trim() };
}

export type PluginManifest = { name: string; version: string; author: string; description: string };

/** Reads a plugin.json. Returns null when it is not a usable manifest (not JSON, no usable name). */
export function parsePluginManifest(raw: string): PluginManifest | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  const name = typeof o.name === "string" ? normalizeSkillName(o.name) : "";
  if (!SKILL_NAME_PATTERN.test(name)) return null;
  const author = typeof o.author === "string" ? o.author : typeof o.author === "object" && o.author !== null && typeof (o.author as { name?: unknown }).name === "string" ? (o.author as { name: string }).name : "";
  const text = (v: unknown) => (typeof v === "string" ? cleanLine(v, SKILL_LIMITS.pluginTextChars) : "");
  return { name, version: text(o.version).slice(0, 40), author: text(author).slice(0, 80), description: text(o.description) };
}
