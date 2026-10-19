import { FOLDER_LIMITS as L, type ChangePreview, type ExecResult } from "@mc/shared";
import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { FolderError, isHiddenName, redactSecrets } from "./folder-fs.ts";
import { resolve, type Item } from "./folder-items.ts";

// Shell commands the AI proposes. Every one is shown to the host and runs only after the host clicks Approve in this app
// and then confirms in a native window (folder-ipc.ts) that the page cannot click. Nothing is remembered: the next
// command asks again, with no "always allow".
//
// There is no sandbox. An approved command runs with the host's own rights, exactly like one typed in a terminal, and
// can read or change anything the host can. The approval is the barrier, so what is approved must be what runs: the
// command, folder and time limit are fixed when the proposal is made and cannot be changed by the AI afterwards.
//
// What this module does limit: the environment (no tokens or keys from the host's environment), standard input (none),
// the process group (killed on time limit, Stop, quit and when the host's app disconnects), how much output is kept,
// and what the output may contain (secret-shaped text masked, terminal control characters removed).

export type ExecStaged = {
  id: string;
  exec: true;
  change: ChangePreview;
  /** Runs the approved command. `onStart` hands out a way to stop it. */
  run: (onStart: (kill: () => void) => void) => Promise<ExecResult>;
};

/** What the command is allowed to see of the host's environment. Tokens and keys are not on this list. */
const ENV_KEEP = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "SystemRoot", "PATHEXT", "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "WINDIR"];

export function execEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_KEEP) if (source[k] !== undefined) env[k] = source[k];
  if (process.platform === "darwin") env.PATH = [env.PATH, "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
  // A tool that waits for input or a pager would hang with nobody there.
  return { ...env, TERM: "dumb", CI: "1", NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", EDITOR: "true" };
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

/** Keeps the start and the end of what a command printed. */
class Tail {
  private head = "";
  private tail = "";
  private total = 0;
  constructor(
    private readonly headMax: number,
    private readonly tailMax: number,
  ) {}
  push(chunk: string) {
    this.total += chunk.length;
    if (this.head.length < this.headMax) {
      const room = this.headMax - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (chunk) this.tail = (this.tail + chunk).slice(-this.tailMax);
  }
  result(): { text: string; truncated: boolean } {
    const kept = this.head.length + this.tail.length;
    if (this.total <= kept) return { text: this.head + this.tail, truncated: false };
    return { text: `${this.head}\n[… ${this.total - kept} characters omitted …]\n${this.tail}`, truncated: true };
  }
}

type Loose = { id?: unknown; command?: unknown; description?: unknown; workdir?: unknown; timeoutSec?: unknown };

/** The folder a command runs in: the one shared folder, or a folder inside a shared one. Links and hidden folders are refused. */
async function workdirOf(items: Item[], workdir: unknown): Promise<{ root: string; cwd: string; shown: string }> {
  const t = resolve(items, workdir ?? "");
  let root: string;
  let parts: string[];
  if (t === "top") {
    const dirs = items.filter((i) => i.kind === "dir");
    if (dirs.length !== 1) throw new FolderError("bad_request", "Several folders are shared. Give workdir as a folder inside the one you mean, like my-app or my-app/src.");
    root = dirs[0]!.abs;
    parts = [];
  } else {
    if (t.single) throw new FolderError("not_a_directory", "workdir must be a folder, not a shared file.");
    root = t.root;
    parts = t.start;
  }
  if (parts.some((p) => isHiddenName(p, true))) throw new FolderError("excluded", "That folder is hidden from the shared folder (secrets, keys, build output and similar).");
  const cwd = join(root, ...parts);
  let at = root;
  for (const p of parts) {
    at = join(at, p);
    const st = await lstat(at).catch(() => null);
    if (!st) throw new FolderError("not_found", "That folder doesn't exist in the shared folder.");
    if (st.isSymbolicLink()) throw new FolderError("excluded", "Links aren't followed, so that folder can't be used.");
    if (!st.isDirectory()) throw new FolderError("not_a_directory", "workdir must be a folder.");
  }
  return { root, cwd, shown: parts.join("/") };
}

const clipLine = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** Works out a proposed command without running anything. Throws a FolderError whose message the AI and the chat can see. */
export async function stageExec(items: Item[], req: Loose): Promise<ExecStaged> {
  const id = req.id as string;
  if (typeof req.command !== "string") throw new FolderError("bad_request", "Give the command as text.");
  const command = req.command.replaceAll("\r\n", "\n");
  if (command.trim() === "" || command.length > L.execChars) {
    throw new FolderError("bad_request", `The command must be 1 to ${L.execChars} characters. For something longer, write a script file with write and run that.`);
  }
  // What the host reads must be what runs: no control characters (other than line breaks and tabs) and no invisible or
  // direction-changing characters that can make a command look different from what it is.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(command)) {
    throw new FolderError("bad_request", "The command contains control or invisible characters, which are not allowed.");
  }
  const sec = typeof req.timeoutSec === "number" && Number.isFinite(req.timeoutSec) ? Math.min(L.execMaxSec, Math.max(1, Math.floor(req.timeoutSec))) : L.execDefaultSec;
  // eslint-disable-next-line no-control-regex
  const note = typeof req.description === "string" ? clipLine(req.description.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim(), 200) : "";
  const dir = await workdirOf(items, req.workdir);

  const change: ChangePreview = {
    id,
    kind: "exec",
    path: "run a command",
    command,
    created: false,
    added: 0,
    removed: 0,
    diff: "",
    cut: false,
    workdir: dir.shown,
    timeoutSec: sec,
    ...(note ? { note } : {}),
  };

  return {
    id,
    exec: true,
    change,
    run: async (onStart) => {
      // Look again: the folder may have been replaced by a link since the proposal was made.
      const again = await workdirOf(items, req.workdir);
      const [realRoot, realCwd] = await Promise.all([realpath(again.root), realpath(again.cwd)]).catch(() => {
        throw new FolderError("not_found", "That folder doesn't exist any more.");
      });
      if (realCwd !== realRoot && !realCwd.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) throw new FolderError("excluded", "That folder is outside the shared folder.");
      return execute(command, again.cwd, sec * 1000, onStart);
    },
  };
}

/** Runs `command` in the user's shell with the trimmed environment. Resolves with how it ended; never rejects for a failing command. */
export function execute(command: string, cwd: string, timeoutMs: number, onStart: (kill: () => void) => void = () => undefined): Promise<ExecResult> {
  return new Promise((resolveRun, reject) => {
    const started = Date.now();
    const win = process.platform === "win32";
    const posixShell = process.platform === "darwin" || process.platform === "linux" ? "/bin/sh" : "sh";
    let child;
    try {
      child = spawn(win ? (process.env.COMSPEC ?? "cmd.exe") : posixShell, win ? ["/d", "/s", "/c", command] : ["-c", `exec 2>&1; ${command}`], {
        cwd,
        env: execEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: !win, // its own process group, so everything it starts can be stopped together
        windowsHide: true,
      });
    } catch {
      return reject(new FolderError("exec_failed", "The command could not be started."));
    }
    const out = new Tail(L.execHeadChars * 4, L.execTailChars * 4);
    let timedOut = false;
    let killed = false;
    const pid = child.pid;
    const kill = () => {
      if (killed || pid === undefined) return;
      killed = true;
      try {
        if (win) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
        else process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    };
    onStart(kill);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    // On macOS and Linux the shell sends stderr into stdout itself (the "exec 2>&1;" in front), so the two stay in order.
    const take = (b: Buffer) => out.push(b.toString("utf8"));
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new FolderError("exec_failed", "The command could not be started."));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // Whatever it left running in its group is stopped too.
      if (!win && pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* nothing left */
        }
      }
      const raw = out.result();
      const cleaned = redactSecrets(cleanOutput(raw.text));
      const cut = cleaned.length > L.execHeadChars + L.execTailChars ? `${cleaned.slice(0, L.execHeadChars)}\n[… output cut …]\n${cleaned.slice(-L.execTailChars)}` : cleaned;
      resolveRun({ command, exitCode: code, signal: signal ?? (killed && !timedOut ? "SIGKILL" : null), timedOut, output: cut, truncated: raw.truncated || cut !== cleaned, ms: Date.now() - started });
    });
  });
}
