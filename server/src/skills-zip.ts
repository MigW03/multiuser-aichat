import { cleanBody, cleanLine, normalizeSkillName, parsePluginManifest, parseSkillMd, skillProblem, SKILL_LIMITS, SKILL_NAME_PATTERN, type PluginManifest, type PluginPreview } from "@mc/shared";
import { unzipSync } from "fflate";

// Reads a plugin file (a .zip with a plugin.json and skills/<name>/SKILL.md files). Only text is ever taken out of it: the
// manifest and the SKILL.md files. Nothing is written to disk, nothing in it is run, and every other file is only counted
// so the person is told what was left out.
//
// The file is from a stranger, so it is checked before it is opened: size of the file, number of entries, and the size
// each wanted entry says it will have when opened. An entry that says it is small but opens bigger is cut off by the
// library at the size it declared, so a lie can't grow it.

/** A refusal with a message that is safe to show. */
export class PluginFileError extends Error {}

const MAX_ENTRIES = 500;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_SKILL_BYTES = 64 * 1024;

export type ReadSkill = { name: string; description: string; body: string; problem: string | null };
export type ReadPlugin = { manifest: PluginManifest; skills: ReadSkill[]; left_out: PluginPreview["left_out"] };

const CODE_FILE = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|exe|dll|so|dylib|jar|wasm)$/i;
const IGNORED = /^(readme|license|licence|changelog|notice|contributing)(\.[a-z]+)?$/i;

function safeName(raw: string): string | null {
  const name = raw.replaceAll("\\", "/");
  if (name.includes("\0") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) throw new PluginFileError("This file has an unsafe path in it, so it was not opened.");
  const parts = name.split("/");
  if (parts.includes("..")) throw new PluginFileError("This file has an unsafe path in it, so it was not opened.");
  // Folder entries and the junk a Mac adds are not files.
  if (name.endsWith("/") || parts[0] === "__MACOSX" || parts.at(-1) === ".DS_Store") return null;
  return parts.filter((p) => p !== "" && p !== ".").join("/");
}

/** Is there a ZIP64 end-of-central-directory record or locator ("PK\x06\x06", "PK\x06\x07") near the end of the file? */
function hasZip64(data: Uint8Array): boolean {
  const from = Math.max(0, data.length - 70_000);
  for (let i = data.length - 4; i >= from; i--) if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x06 && (data[i + 3] === 0x06 || data[i + 3] === 0x07)) return true;
  return false;
}

export function readPluginFile(data: Uint8Array): ReadPlugin {
  if (data.byteLength === 0) throw new PluginFileError("That file is empty.");
  if (data.byteLength > SKILL_LIMITS.zipBytes) throw new PluginFileError("That file is over 1 MB.");
  // A zip starts with "PK".
  if (data[0] !== 0x50 || data[1] !== 0x4b) throw new PluginFileError("That is not a .zip file.");

  // A plugin is small, so it never needs ZIP64. A file that has the ZIP64 end records is refused before it is parsed (the
  // unzip library once looped forever on a malformed one).
  if (hasZip64(data)) throw new PluginFileError("That .zip file uses a format Nido doesn't read (ZIP64).");

  // Pass 1: the names, with nothing opened (the filter says no to every entry).
  const names: string[] = [];
  try {
    unzipSync(data, {
      filter: (f) => {
        if (names.length >= MAX_ENTRIES) throw new PluginFileError(`This file holds more than ${MAX_ENTRIES} files.`);
        const n = safeName(f.name);
        if (n) names.push(n);
        return false;
      },
    });
  } catch (e) {
    if (e instanceof PluginFileError) throw e;
    throw new PluginFileError("That .zip file could not be read.");
  }
  if (names.length === 0) throw new PluginFileError("That file is empty.");

  // A zip of a folder has everything under one top folder: look inside it.
  const first = names[0]!.split("/")[0]!;
  const strip = names.every((n) => n.includes("/") && n.split("/")[0] === first) ? `${first}/` : "";
  const rel = (n: string) => (strip && n.startsWith(strip) ? n.slice(strip.length) : n);

  const manifestFull = names.find((n) => rel(n) === "plugin.json") ?? names.find((n) => rel(n) === ".claude-plugin/plugin.json");
  if (!manifestFull) throw new PluginFileError("No plugin.json found. A plugin file has a plugin.json at its top.");
  const skillFiles = names.filter((n) => /^skills\/[^/]+\/SKILL\.md$/i.test(rel(n)));
  if (skillFiles.length === 0) throw new PluginFileError("There are no skills in this file. Skills live in skills/<name>/SKILL.md.");
  // Before anything is opened: a file with more skills than allowed is refused, so no more than this many are ever unpacked.
  if (skillFiles.length > SKILL_LIMITS.perPlugin) throw new PluginFileError(`A plugin can hold ${SKILL_LIMITS.perPlugin} skills at most.`);

  // Pass 2: open only the manifest and the skill files, each only if it says it is a sensible size.
  const wanted = new Set([manifestFull, ...skillFiles]);
  const opened = new Map<string, Uint8Array>();
  const tooBig = new Set<string>();
  try {
    const out = unzipSync(data, {
      filter: (f) => {
        const n = safeName(f.name);
        if (!n || !wanted.has(n)) return false;
        if (f.originalSize > (n === manifestFull ? MAX_MANIFEST_BYTES : MAX_SKILL_BYTES)) {
          tooBig.add(n);
          return false;
        }
        return true;
      },
    });
    for (const [k, v] of Object.entries(out)) {
      const n = safeName(k);
      if (n) opened.set(n, v);
    }
  } catch (e) {
    if (e instanceof PluginFileError) throw e;
    throw new PluginFileError("That .zip file could not be read.");
  }
  const text = (n: string) => new TextDecoder("utf-8", { fatal: false }).decode(opened.get(n) ?? new Uint8Array());

  if (tooBig.has(manifestFull)) throw new PluginFileError("The plugin.json is too large.");
  const manifest = parsePluginManifest(text(manifestFull));
  if (!manifest) throw new PluginFileError("The plugin.json could not be read. It needs a name made of letters, digits and dashes.");

  const skills: ReadSkill[] = [];
  const seen = new Set<string>();
  for (const path of skillFiles) {
    const dir = rel(path).split("/")[1]!;
    if (tooBig.has(path)) {
      skills.push({ name: normalizeSkillName(dir) || "skill", description: "", body: "", problem: "This SKILL.md is too large." });
      continue;
    }
    const parsed = parseSkillMd(text(path));
    const candidate = normalizeSkillName(parsed.name) || normalizeSkillName(dir);
    const name = SKILL_NAME_PATTERN.test(candidate) ? candidate : "";
    const description = cleanLine(parsed.description, 10_000);
    const body = cleanBody(parsed.body);
    let problem = name ? skillProblem({ name, description, body }) : "This skill has no usable name.";
    if (name && seen.has(name)) problem = "Another skill in this file has the same name.";
    if (name && !problem) seen.add(name);
    skills.push({ name: name || "skill", description, body, problem });
  }

  // What else is in the file: counted, never opened.
  const left_out = { commands: 0, mcp: 0, hooks: 0, scripts: 0, other: 0 };
  const skillSet = new Set(skillFiles);
  for (const n of names) {
    const r = rel(n);
    const base = r.split("/").at(-1)!;
    if (n === manifestFull || skillSet.has(n) || IGNORED.test(base)) continue;
    if (r.startsWith("commands/") || r.startsWith("agents/")) left_out.commands++;
    else if (r === ".mcp.json" || r === "mcp.json" || r.startsWith(".mcp/")) left_out.mcp++;
    else if (r.startsWith("hooks/") || r === "hooks.json") left_out.hooks++;
    else if (CODE_FILE.test(base) || r.startsWith("scripts/") || r.includes("/scripts/")) left_out.scripts++;
    else left_out.other++;
  }
  return { manifest, skills, left_out };
}
