import { alwaysAllowable, classifyCommand, type AllowedCommand } from "@mc/shared";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readScriptTexts } from "./folder-scripts.ts";

// "Always allow this command": commands the owner chose, in the app's own confirmation window, to run without asking again.
//
// What a rule is: one project, one folder on this computer (its real path), the command text exactly as approved (no
// wildcards, no prefixes) and, when the command runs a package.json script, the text of that script and of the hooks npm
// runs around it. If any of it differs, the command asks again. A rule ends after ALLOW_DAYS and while commands are
// switched off. Only the owner's click on the checkbox in the native window adds one (the page cannot), and only Revoke
// removes one. The rules live in a file on this computer (mode 0600), never on the chat server.

export const ALLOW_DAYS = 30;
const DAY = 86_400_000;
export const ALLOW_MAX_PER_PROJECT = 50;

export type Rule = {
  id: string;
  projectId: string;
  /** The real folder the command runs in. */
  cwd: string;
  /** The folder as the card shows it. */
  folder: string;
  command: string;
  /** The script text the command runs, if it is a package script: compared character for character. */
  bound: string[];
  script: boolean;
  createdAt: number;
  lastRunAt: number | null;
};

const NAME = "[A-Za-z0-9_][A-Za-z0-9:_.-]{0,59}";
// `npm build` and `bun build`, `bun test` are programs of the package manager, not scripts: only forms that run a package.json script count.
const RUN = new RegExp(`^(?:npm|pnpm|yarn|bun) run (${NAME})$`);
const BARE = /^(?:npm (test|start|stop|restart)|(?:pnpm|yarn) (test|start|build|dev|lint))$/;

/** The name of the package.json script a command runs (`npm test`, `npm run build`, `yarn lint`), or null. */
export function packageScriptOf(command: string): string | null {
  const m = RUN.exec(command) ?? BARE.exec(command);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

const MANAGER = /^(npm|pnpm|yarn|bun)( |$)/;

/**
 * What a command depends on besides its own text: for a package script, the script and its pre/post hooks as written in
 * package.json now (an empty list when it is not one, or package.json has no such script).
 */
export async function boundTexts(cwd: string, command: string): Promise<string[]> {
  const name = packageScriptOf(command);
  return name ? readScriptTexts(cwd, name) : [];
}

/**
 * Whether a command with this text and these bound script texts may be offered "always allow". A package manager's own
 * commands (update, rebuild, link...) are not: only a script that package.json really has.
 */
export function offerable(command: string, bound: string[]): boolean {
  if (MANAGER.test(command)) {
    const name = packageScriptOf(command);
    if (!name || !bound[0]?.startsWith(`${name}: `)) return false;
  }
  return alwaysAllowable(command) && classifyCommand(bound.join("\n")).length === 0;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

type Stored = { version: 1; rules: Rule[] };

function valid(r: unknown): r is Rule {
  const x = r as Partial<Rule> | null;
  return (
    !!x &&
    typeof x.id === "string" &&
    typeof x.projectId === "string" &&
    typeof x.cwd === "string" &&
    typeof x.folder === "string" &&
    typeof x.command === "string" &&
    Array.isArray(x.bound) &&
    x.bound.every((b) => typeof b === "string") &&
    typeof x.script === "boolean" &&
    typeof x.createdAt === "number" &&
    (x.lastRunAt === null || typeof x.lastRunAt === "number") &&
    alwaysAllowable(x.command)
  );
}

export class AllowStore {
  private rules: Rule[] = [];
  private loaded: Promise<void>;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.loaded = this.load();
  }

  private async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<Stored> | null;
      this.rules = Array.isArray(parsed?.rules) ? parsed.rules.filter(valid) : [];
    } catch {
      this.rules = [];
    }
    this.rules = this.rules.filter((r) => !this.expired(r));
  }

  private expired(r: Rule) {
    return this.now() >= r.createdAt + ALLOW_DAYS * DAY;
  }

  private save() {
    // One write at a time, in order, so a quick Revoke after an Add cannot be undone by a late write.
    this.saving = this.saving.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, rules: this.rules } satisfies Stored), { mode: 0o600 });
      await rename(tmp, this.file);
      await chmod(this.file, 0o600).catch(() => undefined);
    });
    return this.saving.catch((err) => console.error("[folder] could not save always-allowed commands:", err instanceof Error ? err.message : err));
  }

  /** The rule that lets exactly this command run now, or null. */
  async match(projectId: string, cwd: string, command: string, bound: string[]): Promise<Rule | null> {
    await this.loaded;
    return this.rules.find((r) => r.projectId === projectId && r.cwd === cwd && r.command === command && same(r.bound, bound) && !this.expired(r)) ?? null;
  }

  async add(input: { projectId: string; cwd: string; folder: string; command: string; bound: string[]; script: boolean }): Promise<Rule | null> {
    await this.loaded;
    if (!offerable(input.command, input.bound)) return null;
    // The same command in the same folder is one rule: asking again starts its 30 days afresh.
    this.rules = this.rules.filter((r) => !(r.projectId === input.projectId && r.cwd === input.cwd && r.command === input.command));
    if (this.rules.filter((r) => r.projectId === input.projectId).length >= ALLOW_MAX_PER_PROJECT) return null;
    const rule: Rule = { ...input, id: randomUUID(), createdAt: this.now(), lastRunAt: null };
    this.rules.push(rule);
    await this.save();
    return rule;
  }

  async used(id: string) {
    await this.loaded;
    const r = this.rules.find((x) => x.id === id);
    if (!r) return;
    r.lastRunAt = this.now();
    await this.save();
  }

  async list(projectId: string): Promise<AllowedCommand[]> {
    await this.loaded;
    return this.rules
      .filter((r) => r.projectId === projectId && !this.expired(r))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({ id: r.id, command: r.command, folder: r.folder, script: r.script, createdAt: r.createdAt, lastRunAt: r.lastRunAt, expiresAt: r.createdAt + ALLOW_DAYS * DAY }));
  }

  async revoke(projectId: string, id: string): Promise<boolean> {
    await this.loaded;
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => !(r.projectId === projectId && r.id === id));
    if (this.rules.length === before) return false;
    await this.save();
    return true;
  }

  /** Every rule of a project: when its folders are removed or it is unlinked, and for the Revoke all button. */
  async revokeProject(projectId: string): Promise<void> {
    await this.loaded;
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.projectId !== projectId);
    if (this.rules.length !== before) await this.save();
  }
}
