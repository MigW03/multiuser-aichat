import { execFile } from "node:child_process";
import { constants as fsc } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

// Finding and asking the person's own `claude` program. Nothing here reads a credential: signing in is done by the
// person with `claude auth login` in their own terminal, `claude` keeps its own login where it always keeps it, and this
// app only runs `claude` and reads the two short facts it prints about itself (its version, and whether it is signed in).

const isWindows = process.platform === "win32";
const EXE = isWindows ? "claude.exe" : "claude";

/** The usual places, for when the app was started from the dock or start menu and has no shell PATH. */
export function candidatePaths(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const dirs = (env.PATH ?? "").split(delimiter).filter((d) => d && isAbsolute(d));
  const usual = isWindows
    ? [join(home, ".local", "bin"), join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "claude"), join(home, ".claude", "local")]
    : [join(home, ".local", "bin"), join(home, ".claude", "local"), join(home, ".npm-global", "bin"), join(home, ".bun", "bin"), join(home, ".volta", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  return [...new Set([...dirs, ...usual].map((d) => join(d, EXE)))];
}

async function isRunnableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, isWindows ? fsc.F_OK : fsc.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** What `claude --version` prints for the real program: "2.1.322 (Claude Code)". Anything else is not it. */
export const isClaudeVersion = (text: string): boolean => /^\d+\.\d+\.\d+\S*\s+\(Claude Code\)\s*$/.test(text.trim());

type Run = (file: string, args: string[], opts: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string }>;

/** Runs a program with no shell, a time limit and a small output limit. Never throws. */
export const run: Run = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeout, env: opts.env, maxBuffer: 64 * 1024, windowsHide: true, shell: false }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });

/** The environment `claude` is started with: what it needs to find its own sign-in and the network, and nothing else. */
export function claudeEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
    // Where the person told `claude` to keep its own sign-in, if they did.
    "CLAUDE_CONFIG_DIR"];
  const env: Record<string, string> = {};
  for (const k of keep) {
    const v = source[k];
    if (typeof v === "string") env[k] = v;
  }
  if (process.platform === "darwin") env.PATH = [env.PATH, "/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(delimiter);
  // No ANTHROPIC_*, CLAUDE_CODE_USE_* or token variables pass through: this provider is the person's own login, nothing else.
  return env;
}

/** Whether `path` is the real Claude Code program. */
export async function verifyClaude(path: string, exec: Run = run, env: NodeJS.ProcessEnv = claudeEnv()): Promise<boolean> {
  if (!isAbsolute(path) || !(await isRunnableFile(path))) return false;
  const r = await exec(path, ["--version"], { timeout: 15_000, env });
  return r.code === 0 && isClaudeVersion(r.stdout);
}

/** The `claude` to use: the one the person chose, else the first that is really Claude Code on the usual paths. */
export async function findClaude(custom: string | null, exec: Run = run, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (custom) return (await verifyClaude(custom, exec, claudeEnv(env))) ? custom : null;
  for (const c of candidatePaths(env)) if (await verifyClaude(c, exec, claudeEnv(env))) return c;
  return null;
}

export type LoginState = { login: "signed_in" | "signed_out" | "unknown"; account: string | null };

/** A short label for the account line. Printable characters only, cut. */
const label = (v: unknown): string | null => (typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 80) || null : null);

/** Asks `claude` whether it is signed in (`claude auth status`, which only reports; it prints no token). */
export async function loginState(bin: string, exec: Run = run, env: NodeJS.ProcessEnv = claudeEnv()): Promise<LoginState> {
  const r = await exec(bin, ["auth", "status"], { timeout: 20_000, env });
  type Status = { loggedIn?: unknown; email?: unknown; subscriptionType?: unknown };
  let json = null as Status | null;
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Status;
  } catch {
    json = null;
  }
  const signedIn = json?.loggedIn === true || (json?.loggedIn === undefined && r.code === 0 && json !== null);
  const signedOut = json?.loggedIn === false || (json === null && r.code !== 0 && /not logged in|not signed in/i.test(r.stdout));
  if (signedIn) {
    const email = label(json?.email);
    const plan = label(json?.subscriptionType);
    return { login: "signed_in", account: [email, plan].filter(Boolean).join(" · ") || null };
  }
  return { login: signedOut ? "signed_out" : "unknown", account: null };
}
