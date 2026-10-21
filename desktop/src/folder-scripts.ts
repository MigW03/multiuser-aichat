import { cleanOutput, FOLDER_LIMITS as L, redactSecrets, type ChangePreview, type ExecResult, type ScriptInfo, type ScriptRun, type ScriptState } from "@mc/shared";
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { execEnv, type ExecStaged } from "./folder-exec.ts";
import { FolderError } from "./folder-fs.ts";
import type { Item } from "./folder-items.ts";

// The scripts in a shared folder's package.json, with a Run button for each (the Scripts tab of the Files card).
//
// The page never sends command text. It names a shared folder and a script, and this module reads package.json itself and
// builds `npm run <name>` (or pnpm, yarn, bun by the lock file). A name that is not in package.json cannot run, and a name
// is only letters, digits and `: _ . -`, so nothing can be added to the command. Running goes through the same approvals as
// a command the AI proposes: the request waits in the approval dock, and the app asks once more in a window the page cannot
// click (folder-ipc.ts). Every start asks again, unless the host ticked "always allow" there (folder-allow.ts).
//
// A script is meant to keep running (a dev server), so unlike a command the AI proposes it has no time limit, its output
// is streamed into a log and several can run at once (up to L.scriptsRunning in a project). It runs with the same trimmed
// environment as a command, the same masking of secret-shaped output, and in its own process group so that Stop ends
// everything it started. There is no sandbox: it runs with the owner's own rights.

/** A script name as npm accepts it for `npm run`, but without a leading dash (it could pass for an option). */
const SCRIPT_NAME = /^[A-Za-z0-9_][A-Za-z0-9:_.-]{0,59}$/;

/** Run by npm itself around installs and publishes, or before and after another script: not shown as buttons. */
const LIFECYCLE = new Set(["install", "uninstall", "version", "preinstall", "postinstall", "prepare", "prepublish", "prepublishOnly", "publish", "prepack", "postpack", "postpublish", "preversion", "postversion"]);
/** Listed first, in this order; the rest follow A to Z. */
const FIRST = ["dev", "start", "build", "test", "lint"];

export type Manager = "npm" | "pnpm" | "yarn" | "bun";

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

/** The package manager the folder uses, by its lock file. */
export async function managerOf(dir: string): Promise<Manager> {
  if (await exists(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(dir, "yarn.lock"))) return "yarn";
  if ((await exists(join(dir, "bun.lockb"))) || (await exists(join(dir, "bun.lock")))) return "bun";
  return "npm";
}

/** What the person reads of a script's body: control and invisible characters (which could hide what it does) are shown as a dot. */
// eslint-disable-next-line no-control-regex
const VISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const plain = (body: string) => body.replace(VISIBLE, "·");
/** For the list, where a long script is cut. The approval shows it whole (see stageScript). */
const shown = (body: string) => {
  const one = plain(body);
  return one.length > L.scriptBodyChars ? `${one.slice(0, L.scriptBodyChars)}…` : one;
};

/** Every script of `dir/package.json` that is plain text, hooks included. Empty when there is no readable package.json. */
async function readAll(dir: string): Promise<[string, string][]> {
  const file = join(dir, "package.json");
  let text: string;
  try {
    // A link is not followed (it could point anywhere), and a big file is not read.
    const st = await lstat(file);
    if (!st.isFile() || st.size > L.packageJsonBytes) return [];
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  let scripts: unknown;
  try {
    scripts = (JSON.parse(text) as { scripts?: unknown } | null)?.scripts;
  } catch {
    return [];
  }
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];
  return Object.entries(scripts as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string");
}

/** A script as written in `dir/package.json` ("name: body"), then the `pre` and `post` hooks npm runs around it. Empty when there is no such script. */
export async function readScriptTexts(dir: string, name: string): Promise<string[]> {
  const all = await readAll(dir);
  const main = all.find(([n]) => n === name);
  if (!main) return [];
  return [`${name}: ${main[1]}`, ...all.filter(([n]) => n === `pre${name}` || n === `post${name}`).map(([n, b]) => `${n}: ${b}`)];
}

/** The runnable scripts of `dir/package.json`, in the order they are listed. Empty when there is no readable package.json. */
export async function readScripts(dir: string): Promise<{ name: string; body: string }[]> {
  const all = await readAll(dir);
  const names = new Set(all.map(([n]) => n));
  const hook = (n: string) => LIFECYCLE.has(n) || (/^(pre|post)./.test(n) && names.has(n.replace(/^(pre|post)/, "")));
  const rank = (n: string) => (FIRST.includes(n) ? FIRST.indexOf(n) : FIRST.length);
  return all
    .filter(([n]) => SCRIPT_NAME.test(n) && !hook(n))
    .map(([name, body]) => ({ name, body }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
    .slice(0, L.scriptsListed);
}

/** The scripts of every shared folder (approved items only, which is what `items` holds). */
export async function listScripts(items: Item[]): Promise<ScriptInfo[]> {
  const out: ScriptInfo[] = [];
  for (const item of items) {
    if (item.kind !== "dir" || !item.key) continue;
    const [list, manager] = await Promise.all([readScripts(item.abs), managerOf(item.abs)]);
    for (const s of list) out.push({ key: item.key, folder: item.name, name: s.name, body: shown(s.body), command: `${manager} run ${s.name}` });
  }
  return out;
}

type Request = { id?: unknown; key?: unknown; name?: unknown };

/**
 * Works out a Run click without running anything. Throws a FolderError whose message is shown. `start` is called when the
 * host has approved and confirmed it: it starts the script (see ScriptRunner.start) and returns at once.
 */
export async function stageScript(items: Item[], req: Request, start: (cwd: string, command: string) => void): Promise<ExecStaged> {
  const id = req.id as string;
  if (typeof req.key !== "string" || typeof req.name !== "string" || !SCRIPT_NAME.test(req.name)) throw new FolderError("bad_request", "Name a script from package.json.");
  const name = req.name;
  const item = items.find((i) => i.kind === "dir" && i.key === req.key);
  if (!item) throw new FolderError("not_found", "That folder isn't shared any more.");
  const read = async () => {
    const found = (await readScripts(item.abs)).find((s) => s.name === name);
    if (!found) throw new FolderError("not_found", `package.json has no script called ${name}.`);
    // npm also runs `pre<name>` before it and `post<name>` after it: what the host confirms must include them.
    const around = (await readAll(item.abs)).filter(([n]) => n === `pre${name}` || n === `post${name}`).map(([n, b]) => `${n}: ${b}`);
    return { body: found.body, around, command: `${await managerOf(item.abs)} run ${name}` };
  };
  const first = await read();
  // The host reads all of it before approving, so a script too long to show whole is not run from here.
  if (first.body.length + first.around.join("\n").length > L.execChars) throw new FolderError("bad_request", "That script's text is too long to show in full, so it can't be run from here.");
  const change: ChangePreview = {
    id,
    kind: "exec",
    path: "run a script",
    command: first.command,
    created: false,
    added: 0,
    removed: 0,
    diff: "",
    cut: false,
    workdir: item.name,
    timeoutSec: 0,
    script: { name, body: plain(first.body), ...(first.around.length ? { around: first.around.map(plain) } : {}) },
  };
  return {
    id,
    exec: true,
    change,
    cwd: item.abs,
    run: async () => {
      // What the host read is what runs: if package.json (or the lock file) changed meanwhile, ask again.
      const now = await read();
      if (now.body !== first.body || now.command !== first.command || now.around.join("\n") !== first.around.join("\n")) throw new FolderError("stale", "package.json changed after you clicked Run. Run it again to see what it does now.");
      // Look again: the folder may have been replaced by a link since it was shared.
      const st = await lstat(item.abs).catch(() => null);
      if (!st) throw new FolderError("not_found", "That folder doesn't exist any more.");
      if (st.isSymbolicLink()) throw new FolderError("excluded", "Links aren't followed, so that folder can't be used.");
      start(item.abs, first.command);
      const r: ExecResult = { command: first.command, exitCode: null, signal: null, timedOut: false, output: "", truncated: false, ms: 0 };
      return r;
    },
  };
}

/** The environment a script sees: the same trimmed one as a command, without CI (a dev server should act as in a terminal) and told not to open a browser. */
export function scriptEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...execEnv(source) };
  delete env.CI;
  env.BROWSER = "none";
  return env;
}

/** The end of what a script printed: whole lines, cleaned and with secret-shaped text masked, cut to the last lines and characters. */
export class LineLog {
  private lines: string[] = [];
  private chars = 0;
  private partial = "";
  private readonly decoder = new StringDecoder("utf8");

  push(chunk: Buffer) {
    const raw = this.partial + this.decoder.write(chunk);
    const cut = Math.max(raw.lastIndexOf("\n"), raw.lastIndexOf("\r"));
    let head = raw.slice(0, cut + 1);
    this.partial = raw.slice(cut + 1);
    // One enormous line without a break is taken as it is.
    if (this.partial.length > 4_000) {
      head += this.partial + "\n";
      this.partial = "";
    }
    if (head) for (const line of cleanOutput(head).replace(/\n$/, "").split("\n")) this.add(line);
  }

  /** The process ended: the last, unfinished line counts too. */
  end() {
    const rest = this.partial + this.decoder.end();
    this.partial = "";
    if (rest) this.add(cleanOutput(rest));
  }

  text(): string {
    const tail = this.partial ? [redactSecrets(cleanOutput(this.partial))] : [];
    return [...this.lines, ...tail].join("\n");
  }

  private add(line: string) {
    const safe = redactSecrets(line.length > 2_000 ? `${line.slice(0, 2_000)}…` : line);
    this.lines.push(safe);
    this.chars += safe.length + 1;
    while (this.lines.length > 1 && (this.lines.length > L.scriptLogLines || this.chars > L.scriptLogChars)) this.chars -= this.lines.shift()!.length + 1;
  }
}

type Rec = {
  projectId: string;
  key: string;
  name: string;
  state: ScriptState;
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  unseen: boolean;
  note: string | null;
  log: LineLog;
  kill: (force: boolean) => void;
  stopRequested: boolean;
};

const idOf = (projectId: string, key: string, name: string) => `${projectId}\n${key}\n${name}`;
const live = (r: Rec) => r.state === "run" || r.state === "stopping";

/** The scripts that run or ran in this app, with their logs. Lives in memory only. */
export class ScriptRunner {
  private readonly recs = new Map<string, Rec>();
  private readonly waiting = new Set<string>();
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `onChange` hears (at most every 150 ms per burst) that a project's runs or logs changed. */
  constructor(private readonly onChange: (projectId: string) => void) {}

  private touch(projectId: string) {
    this.dirty.add(projectId);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const ids = [...this.dirty];
      this.dirty.clear();
      for (const id of ids) this.onChange(id);
    }, 150);
    this.timer.unref?.();
  }

  /** What the page shows for a project: a script waiting for approval, running, or how it ended. */
  runs(projectId: string): ScriptRun[] {
    const out: ScriptRun[] = [];
    const seen = new Set<string>();
    for (const r of this.recs.values()) {
      if (r.projectId !== projectId) continue;
      seen.add(idOf(projectId, r.key, r.name));
      const waits = this.waiting.has(idOf(projectId, r.key, r.name)) && !live(r);
      out.push({ key: r.key, name: r.name, state: waits ? "wait" : r.state, startedAt: r.startedAt, endedAt: r.endedAt, exitCode: r.exitCode, unseen: r.unseen, note: r.note });
    }
    for (const id of this.waiting) {
      const [p, key, name] = id.split("\n");
      if (p === projectId && !seen.has(id)) out.push({ key: key!, name: name!, state: "wait", startedAt: null, endedAt: null, exitCode: null, unseen: false, note: null });
    }
    return out;
  }

  runningIn(projectId: string): number {
    return [...this.recs.values()].filter((r) => r.projectId === projectId && live(r)).length;
  }

  /** A request for this script is waiting for the host. */
  setWaiting(projectId: string, key: string, name: string, on: boolean) {
    const id = idOf(projectId, key, name);
    if (on) this.waiting.add(id);
    else this.waiting.delete(id);
    this.touch(projectId);
  }

  isWaiting(projectId: string, key: string, name: string): boolean {
    return this.waiting.has(idOf(projectId, key, name));
  }

  /** It could not be started (the request failed after the host approved it). Shown on its row. */
  fail(projectId: string, key: string, name: string, note: string) {
    const id = idOf(projectId, key, name);
    const old = this.recs.get(id);
    if (old && live(old)) return;
    this.recs.set(id, { projectId, key, name, state: "crash", startedAt: null, endedAt: Date.now(), exitCode: null, unseen: true, note: note.slice(0, 300), log: new LineLog(), kill: () => undefined, stopRequested: false });
    this.touch(projectId);
  }

  /** Starts `command` in `cwd`. Returns at once; the script keeps running in the background. */
  start(projectId: string, key: string, name: string, command: string, cwd: string) {
    const id = idOf(projectId, key, name);
    const old = this.recs.get(id);
    if (old && live(old)) throw new FolderError("busy", "That script is already running.");
    if (this.runningIn(projectId) >= L.scriptsRunning) throw new FolderError("busy", `Up to ${L.scriptsRunning} scripts run at once in a project. Stop one first.`);
    const win = process.platform === "win32";
    const posixShell = process.platform === "darwin" || process.platform === "linux" ? "/bin/sh" : "sh";
    let child;
    try {
      child = spawn(win ? (process.env.COMSPEC ?? "cmd.exe") : posixShell, win ? ["/d", "/s", "/c", command] : ["-c", `exec 2>&1; ${command}`], {
        cwd,
        env: scriptEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: !win, // its own process group, so everything it starts can be stopped together
        windowsHide: true,
      });
    } catch {
      throw new FolderError("exec_failed", "The script could not be started.");
    }
    const pid = child.pid;
    let escalate: ReturnType<typeof setTimeout> | null = null;
    const rec: Rec = {
      projectId,
      key,
      name,
      state: "run",
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      unseen: false,
      note: null,
      log: new LineLog(),
      stopRequested: false,
      kill: (force) => {
        if (pid === undefined) return;
        try {
          if (win) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
          else process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
        } catch {
          /* already gone */
        }
        // A polite stop is followed by a forced one if it has not ended on its own.
        if (!force && !win && !escalate) {
          escalate = setTimeout(() => {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              /* already gone */
            }
          }, L.scriptStopMs);
          escalate.unref?.();
        }
      },
    };
    this.recs.set(id, rec);
    const take = (b: Buffer) => {
      rec.log.push(b);
      this.touch(projectId);
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    child.on("error", () => {
      if (escalate) clearTimeout(escalate);
      rec.log.end();
      Object.assign(rec, { state: "crash" as const, endedAt: Date.now(), unseen: true, note: "The script could not be started." });
      this.touch(projectId);
    });
    child.on("close", (code) => {
      if (escalate) clearTimeout(escalate);
      // Whatever it left running in its group is stopped too.
      if (!win && pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* nothing left */
        }
      }
      rec.log.end();
      rec.endedAt = Date.now();
      rec.exitCode = code;
      rec.state = rec.stopRequested ? "stopped" : code === 0 ? "ok" : "crash";
      rec.unseen = rec.state === "crash";
      this.touch(projectId);
    });
    this.touch(projectId);
  }

  /** Stops one script and everything it started: a polite stop first, a forced one after a few seconds. */
  stop(projectId: string, key: string, name: string): boolean {
    const r = this.recs.get(idOf(projectId, key, name));
    if (!r || r.state !== "run") return false;
    r.stopRequested = true;
    r.state = "stopping";
    r.kill(false);
    this.touch(projectId);
    return true;
  }

  /** Stops every script of a project (commands turned off, the owner left, ...). `force` skips the polite stop: used when the app quits. */
  stopProject(projectId: string, force = false) {
    for (const r of this.recs.values()) if (r.projectId === projectId && live(r)) this.stopRec(r, force);
  }

  /** Stops the scripts of one shared folder (it is not shared any more). */
  stopItem(projectId: string, key: string) {
    for (const r of this.recs.values()) if (r.projectId === projectId && r.key === key && live(r)) this.stopRec(r, false);
  }

  stopAll() {
    for (const r of this.recs.values()) if (live(r)) this.stopRec(r, true);
  }

  private stopRec(r: Rec, force: boolean) {
    r.stopRequested = true;
    r.state = "stopping";
    r.kill(force);
    this.touch(r.projectId);
  }

  log(projectId: string, key: string, name: string): string | null {
    return this.recs.get(idOf(projectId, key, name))?.log.text() ?? null;
  }

  /** Empties the log of a script that is not running. */
  clearLog(projectId: string, key: string, name: string) {
    const r = this.recs.get(idOf(projectId, key, name));
    if (!r || live(r)) return;
    r.log = new LineLog();
    this.touch(projectId);
  }

  /** The person has looked at the Scripts tab: a crash is not news any more. */
  markSeen(projectId: string) {
    let any = false;
    for (const r of this.recs.values()) {
      if (r.projectId !== projectId || !r.unseen) continue;
      r.unseen = false;
      any = true;
    }
    if (any) this.touch(projectId);
  }
}
