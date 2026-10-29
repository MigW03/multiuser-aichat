import { alwaysAllowable, classifyCommand, RISKY_FILE, type CommandFlag } from "@mc/shared";
import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { Staged } from "./folder-changes.ts";
import type { ExecStaged } from "./folder-exec.ts";
import { boundTexts, offerable, packageScriptOf } from "./folder-allow.ts";
import { isHiddenName } from "./folder-fs.ts";

// What may happen without a click, once the owner chose it for a project (Project settings; confirmed in a window the app
// itself shows). Two settings, each off by default, each only meaningful while its switch (edit, commands) is on:
//
//  edit  An edit to an existing file, or a new file, is written at once. Still asks: a whole file replaced, a file that
//        runs code (package.json, scripts, CI, Dockerfile, hooks, anything executable), a change over AUTO_MAX_LINES lines.
//        What stageChange() already refuses (secrets, hidden files, links, binary, outside the folder) stays refused.
//  exec  A short list runs at once: `pwd`, `ls` inside the folder, and the project's own checks (`npm test`,
//        `npm run lint|typecheck|check|build`, pnpm and yarn forms) when package.json really has the script and the script
//        and its hooks pass the same plain-text check as "always allow". Everything else asks, as before.
//
// There is no sandbox, and a test or build runs the project's code. If edits saved without a click and tests ran without
// a click, the AI could write a test file and run it with the host's rights and no human step. So a check is held (asks)
// while the AI has saved files nobody reviewed since: the host's approval of a command (whose card lists those files)
// clears them. After the app starts with "save" on, the files saved in an earlier run count as unreviewed too.

export const AUTO_MAX_LINES = 200;
/** After this many saved files with no command approved in between, edits ask again. */
export const AUTO_MAX_UNREVIEWED = 50;

export type AutoDecision = { auto: true; kind: "edit" | "read" | "check" } | { auto: false; reason?: string; unreviewed?: string[] };

/** The files the AI saved without asking that the host has not looked at since, per project. In memory only. */
export class Unreviewed {
  private readonly map = new Map<string, { paths: Set<string>; earlier: boolean }>();

  private of(projectId: string) {
    let e = this.map.get(projectId);
    if (!e) this.map.set(projectId, (e = { paths: new Set(), earlier: false }));
    return e;
  }

  add(projectId: string, path: string) {
    this.of(projectId).paths.add(path);
  }

  /** The app started with "save without asking" on: what was saved before this run is not known, so it counts as unreviewed. */
  seedEarlier(projectId: string) {
    this.of(projectId).earlier = true;
  }

  count(projectId: string): number {
    const e = this.map.get(projectId);
    return e ? e.paths.size + (e.earlier ? 1 : 0) : 0;
  }

  /** Names to show the host, newest last; "earlier" when it is from before this run. */
  list(projectId: string): string[] {
    const e = this.map.get(projectId);
    return e ? [...(e.earlier ? ["files saved before the app started"] : []), ...e.paths] : [];
  }

  clear(projectId: string) {
    this.map.delete(projectId);
  }
}

// ------------------------------------------------------------------ edits

export function editDecision(s: Staged, unreviewed: number): AutoDecision {
  if (s.kind === "write" && !s.created) return { auto: false, reason: "Asking because it replaces a whole file." };
  if (RISKY_FILE.test(s.change.path) || RISKY_FILE.test(s.parts.join("/")) || (s.mode & 0o111) !== 0) return { auto: false, reason: "Asking because this file runs code when the project is built, installed or started." };
  if (s.change.cut || s.change.added + s.change.removed > AUTO_MAX_LINES) return { auto: false, reason: "Asking because the change is large." };
  if (unreviewed >= AUTO_MAX_UNREVIEWED) return { auto: false, reason: "Asking because the AI has saved many files you have not looked at." };
  return { auto: true, kind: "edit" };
}

// ------------------------------------------------------------------ commands

const LS = /^ls((?: -[alhRtSrF1]{1,8})*)(?: ([A-Za-z0-9_][A-Za-z0-9_./-]*))?$/;
/** A package.json script that only checks the project. */
const CHECK_NAME = /^(?:test|lint|typecheck|check|build)(?::[A-Za-z0-9_.-]+)?$/;

const WHY: Record<CommandFlag["kind"], string> = {
  destructive: "it deletes or overwrites files",
  network: "it uses the network or installs packages",
  privileged: "it runs with extra privileges",
  secrets: "it may read secrets or your environment",
  "shell-pipe": "it runs code it downloads or decodes",
  background: "it starts something that keeps running",
};

/** `ls` that stays inside the folder it runs in, with plain flags and no hidden names. */
async function lsInside(cwd: string, command: string): Promise<boolean> {
  const m = LS.exec(command);
  if (!m) return false;
  const arg = m[2];
  if (!arg) return true;
  const parts = arg.split("/").filter(Boolean);
  if (parts.some((p) => p === ".." || p === "." || isHiddenName(p, true))) return false;
  try {
    const [base, target] = await Promise.all([realpath(cwd), realpath(join(cwd, ...parts))]);
    return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
  } catch {
    return false; // missing: let the command say so, after asking
  }
}

const few = (names: string[]) => (names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", "));

/**
 * Whether a command the AI proposed may run now. `held`: the AI saved files nobody reviewed (see the top of this file).
 * Never throws: anything unexpected is "ask".
 */
export async function execDecision(staged: ExecStaged, held: string[]): Promise<AutoDecision> {
  const command = staged.change.command ?? "";
  // A script the host started from the Scripts tab already had their click.
  if (staged.change.script) return { auto: false };
  try {
    if (alwaysAllowable(command)) {
      if (command === "pwd") return { auto: true, kind: "read" };
      if (command.startsWith("ls") && (await lsInside(staged.cwd, command))) return { auto: true, kind: "read" };
      const name = packageScriptOf(command);
      if (name && CHECK_NAME.test(name)) {
        const bound = await boundTexts(staged.cwd, command);
        if (!offerable(command, bound)) return { auto: false, reason: "Asking because the script in package.json is not plain enough to run without asking." };
        if (held.length > 0) return { auto: false, reason: `Asking because the AI saved files without your review: ${few(held)}. Tests and builds run code in your project.`, unreviewed: held.slice(-20) };
        return { auto: true, kind: "check" };
      }
    }
  } catch {
    return { auto: false };
  }
  const flags = classifyCommand(command);
  return { auto: false, reason: flags.length ? `Asking because ${WHY[flags[0]!.kind]}.` : "Asking because it is not on the safe list." };
}
