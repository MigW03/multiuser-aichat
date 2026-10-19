import { FOLDER_LIMITS as L, type ChangePreview, type GitChangeResult, type GitStatusFile, type GitStatusResult, type GitTextResult } from "@mc/shared";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, mkdtempSync, realpathSync, statSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { FolderError, isHiddenName, redactSecrets, splitPath } from "./folder-fs.ts";
import { resolve, type Item } from "./folder-items.ts";

// Git on the host's computer for the project's members and the AI.
//
//  - Reads (status, diff, log, show) run without asking, as read, glob and grep do. The AI never writes a command: this
//    module builds every argument list itself from checked values, and runs git directly (no shell).
//  - Writes (add, commit, restore, a new branch) are proposals like file edits: they are staged here (what would
//    happen, no change made), shown to the host, and run only by the host's click in this app. The approval is sealed to
//    the state the host looked at (HEAD, the index, the diff), so a repository that changed meanwhile is refused.
//
// Git can run programs named in a repository's own config or hooks, so: hooks, fsmonitor, pagers, external diff and
// signing are switched off on every call, the user's and the system's git config are not read, a repository whose own
// config defines filters or diff/merge drivers is refused, and nothing hidden (.env, keys, .git...) is shown, added or
// committed. Output passes through the same secret masking as file reads. Error text from git never leaves this
// computer, because it holds paths of this computer.

export type GitStaged = {
  id: string;
  /** Marks this as a git action (files use `Staged` from folder-changes.ts). */
  git: true;
  change: ChangePreview;
  /** Runs the approved action. Throws FolderError `stale` when the repository is no longer what the host looked at. */
  apply: () => Promise<GitChangeResult>;
};

// ------------------------------------------------------------------ running git

let emptyHooks: string | null = null;
const hooksDir = () => (emptyHooks ??= mkdtempSync(join(tmpdir(), "mc-nohooks-")));

/** Settings forced on every call. Each one closes a way for a repository's own files to run a program. */
const forced = () => [
  "-c", `core.hooksPath=${hooksDir()}`,
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "core.editor=true",
  "-c", "core.askPass=",
  "-c", "core.sshCommand=false",
  "-c", "core.quotePath=false",
  "-c", "diff.external=",
  "-c", "credential.helper=",
  "-c", "commit.gpgsign=false",
  "-c", "tag.gpgsign=false",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  "-c", "advice.detachedHead=false",
];

function baseEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "SYSTEMROOT", "PATHEXT", "TMPDIR", "TEMP", "TMP", "COMSPEC", "LANG"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  // A packaged app started from the Finder has a short PATH; the usual places for git on macOS are added.
  if (process.platform === "darwin") env.PATH = [env.PATH, "/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
  return env;
}

let gitPath: string | null = null;

/**
 * The git program, found once by walking PATH. It is run by its full path: on Windows a program of that name in the
 * shared folder itself would otherwise be found first and run.
 */
export function gitBinary(): string {
  if (gitPath) return gitPath;
  const names = process.platform === "win32" ? ["git.exe"] : ["git"];
  for (const dir of (baseEnv().PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue; // "." and other relative entries mean "here"
    for (const name of names) {
      const full = join(dir, name);
      try {
        if (statSync(full).isFile()) {
          accessSync(full, fsConstants.X_OK);
          return (gitPath = full);
        }
      } catch {
        /* not here */
      }
    }
  }
  throw new FolderError("git_failed", "Git is not installed on the host's computer.");
}

type Run = { cwd: string; input?: string; maxChars?: number; timeoutMs?: number; env?: NodeJS.ProcessEnv; locks?: boolean; trusted?: boolean; quiet?: boolean };

/** Runs git with the forced settings. Never throws git's own text: failures become a FolderError with a plain message. */
export function git(args: string[], o: Run): Promise<{ out: string; truncated: boolean }> {
  const maxChars = o.maxChars ?? L.gitChars * 4;
  return new Promise((resolveRun, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      GIT_ASKPASS: "",
      GIT_EXTERNAL_DIFF: "",
      GIT_SSH_COMMAND: "false",
      LC_ALL: "C",
      ...(o.locks ? {} : { GIT_OPTIONAL_LOCKS: "0" }),
      ...o.env,
    };
    // `trusted` is for reading the person's own identity (user.name, user.email): plain `git config --get`, which runs nothing.
    const argv = o.trusted ? args : [...forced(), ...args];
    if (o.trusted) {
      delete env.GIT_CONFIG_NOSYSTEM;
      delete env.GIT_CONFIG_GLOBAL;
      env.HOME = process.env.HOME ?? "";
      if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE;
    }
    let child;
    try {
      child = spawn(gitBinary(), argv, { cwd: o.cwd, env, windowsHide: true, stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (e) {
      return reject(e instanceof FolderError ? e : new FolderError("git_failed", "Git could not be started on the host's computer."));
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, o.timeoutMs ?? L.gitMs);
    child.stdout!.on("data", (b: Buffer) => {
      bytes += b.length;
      if (bytes > maxChars * 4) {
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      out.push(b);
    });
    child.stderr!.on("data", (b: Buffer) => err.length < 64 && err.push(b));
    child.on("error", () => {
      clearTimeout(timer);
      reject(new FolderError("git_failed", "Git is not available on the host's computer."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new FolderError("timeout", "Git took too long, so it was stopped."));
      if (code !== 0 && !truncated) {
        if (!o.quiet) console.error("[git] failed:", args[0], Buffer.concat(err).toString("utf8").slice(0, 200).replace(/\s+/g, " "));
        return reject(new FolderError("git_failed", "Git refused that."));
      }
      let text = Buffer.concat(out).toString("utf8");
      if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        truncated = true;
      }
      resolveRun({ out: text, truncated });
    });
    if (o.input !== undefined) child.stdin!.end(o.input);
  });
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ------------------------------------------------------------------ where, and whether it is safe

/**
 * A path (relative to a folder) with a hidden part: .env, keys, .git, node_modules, build output. `lastIsDir`: the last
 * part may be a folder (a path someone typed); false when it is known to be a file (an entry git listed).
 */
export function hiddenPath(rel: string, lastIsDir = false): boolean {
  const parts = rel.split("/").filter(Boolean);
  return parts.some((p, i) => isHiddenName(p, lastIsDir || i < parts.length - 1));
}

type Scope = {
  /** Folder git runs in: the shared item, or a folder inside it. */
  cwd: string;
  /** A file or folder inside `cwd` that results are limited to; null for everything in `cwd`. */
  spec: string | null;
};

/** Picks the repository: the one shared folder, or the one named by `path` in a share of several. */
async function scopeOf(items: Item[], path: unknown): Promise<Scope> {
  const t = resolve(items, path ?? "");
  const dirs = items.filter((i) => i.kind === "dir");
  if (t === "top") {
    if (dirs.length !== 1) throw new FolderError("bad_request", "Several folders are shared. Give path as a file or folder inside the one you mean, like my-app/src.");
    return { cwd: dirs[0]!.abs, spec: null };
  }
  if (t.single) throw new FolderError("no_repo", "That is a single shared file, not a folder in a git repository.");
  const cwdParts = t.start;
  let cwd = join(t.root, ...cwdParts);
  let spec: string | null = null;
  if (cwdParts.length > 0) {
    // A file is a pathspec inside its folder.
    const st = await lstat(cwd).catch(() => null);
    if (!st) throw new FolderError("not_found", "That file or folder doesn't exist in the shared folder.");
    if (st.isSymbolicLink()) throw new FolderError("excluded", "Links aren't followed, so that path can't be used.");
    if (!st.isDirectory()) {
      spec = basename(cwd);
      cwd = dirname(cwd);
    }
  }
  if (cwdParts.some((p, i) => isHiddenName(p, i < cwdParts.length - 1 || spec === null))) throw new FolderError("excluded", "That path is hidden from the shared folder.");
  return { cwd, spec };
}

export type Repo = { cwd: string; /** Path of `cwd` inside the repository, "" at its top, otherwise ending in "/". */ prefix: string };

/** Checks `cwd` is inside a git work tree, whose config cannot run programs. */
export async function repoOf(cwd: string): Promise<Repo> {
  let top: string;
  let prefix: string;
  try {
    const r = await git(["rev-parse", "--show-toplevel", "--show-prefix"], { cwd });
    [top = "", prefix = ""] = r.out.split("\n");
  } catch (e) {
    if (e instanceof FolderError && e.code === "git_failed") throw new FolderError("no_repo", "The shared folder is not a git repository.");
    throw e;
  }
  // The work tree must contain the folder (a config could point core.worktree somewhere else).
  let realTop: string;
  let realCwd: string;
  try {
    realTop = realpathSync(top);
    realCwd = realpathSync(cwd);
  } catch {
    throw new FolderError("no_repo", "The shared folder is not a git repository.");
  }
  if (realCwd !== realTop && !realCwd.startsWith(realTop.endsWith(sep) ? realTop : realTop + sep)) throw new FolderError("git_unsafe", "This repository is set up in a way git is not used on.");
  // Filters and diff/merge drivers named in the repository's own config run programs on `git add`, `git status`, `git diff`.
  // They cannot be switched off from outside, so such a repository is not used.
  let keys = "";
  try {
    keys = (await git(["config", "--local", "--includes", "--name-only", "--get-regexp", "^(filter|diff|merge)\\..*\\.(clean|smudge|process|textconv|driver|command)$|^diff\\.external$|^core\\.(worktree|fsmonitor)$|^include"], { cwd, quiet: true })).out;
  } catch {
    keys = ""; // exit 1: no such key
  }
  const bad = keys.split("\n").filter(Boolean);
  if (bad.some((k) => !/^core\.fsmonitor$|^diff\.external$/i.test(k))) {
    throw new FolderError("git_unsafe", "This repository's own config runs programs (filters, diff or merge drivers, includes), so git is not used on it.");
  }
  return { cwd, prefix: prefix.trim() };
}

// ------------------------------------------------------------------ reads

/** The part of a repository-relative path inside `repo.prefix`, or null when it lies outside. */
const inside = (repo: Repo, path: string) => (repo.prefix === "" ? path : path.startsWith(repo.prefix) ? path.slice(repo.prefix.length) : null);

/** `git status` entries under `specs` (relative to cwd), without hidden paths. */
async function statusEntries(repo: Repo, specs: string[]): Promise<{ files: GitStatusFile[]; branch: string | null; raw: string; truncated: boolean }> {
  const r = await git(["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all", "--no-renames", "--", ...(specs.length ? specs.map(literal) : ["."])], { cwd: repo.cwd });
  const tokens = r.out.split("\0");
  let branch: string | null = null;
  const files: GitStatusFile[] = [];
  let truncated = r.truncated;
  for (const tok of tokens) {
    if (tok === "") continue;
    if (tok.startsWith("## ")) {
      branch = tok.slice(3).split("...")[0]!.replace(/^No commits yet on /, "").replace(/^Initial commit on /, "").slice(0, 100);
      continue;
    }
    const index = tok[0] ?? " ";
    const worktree = tok[1] ?? " ";
    // porcelain v1 paths are relative to the repository's top
    const rel = inside(repo, tok.slice(3));
    if (rel === null || rel === "" || hiddenPath(rel) || /[\u0000-\u001f\u007f-\u009f]/.test(rel)) continue;
    if (files.length >= L.gitFiles) {
      truncated = true;
      break;
    }
    files.push({ path: rel, index, worktree });
  }
  return { files, branch, raw: r.out, truncated };
}

const literal = (p: string) => `:(literal)${p}`;

/** Drops the sections of a diff that belong to hidden paths. */
function visibleDiff(text: string): string {
  const sections = text.split(/^(?=diff --git )/m);
  return sections
    .filter((s) => {
      if (!s.startsWith("diff --git ")) return true; // what comes before the first file (a commit's header)
      const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(s.split("\n")[0]!);
      // A header git had to quote (odd characters in the name) cannot be read safely, so that file is left out.
      return !!m && !hiddenPath(m[1]!) && !hiddenPath(m[2]!);
    })
    .join("");
}

const clip = (text: string, max: number = L.gitChars): { text: string; truncated: boolean } => (text.length > max ? { text: `${text.slice(0, max)}\n… [cut]`, truncated: true } : { text, truncated: false });

type Loose = { sub?: unknown; target?: unknown; path?: unknown; limit?: unknown; rev?: unknown };

export async function gitRead(items: Item[], req: Loose): Promise<GitStatusResult | GitTextResult> {
  const scope = await scopeOf(items, req.path);
  const repo = await repoOf(scope.cwd);
  const specs = scope.spec ? [scope.spec] : [];
  switch (req.sub) {
    case "status": {
      const s = await statusEntries(repo, specs);
      return { branch: s.branch, files: s.files, truncated: s.truncated };
    }
    case "diff": {
      const target = req.target === "staged" ? ["--cached"] : req.target === "head" ? ["HEAD"] : [];
      let r;
      try {
        r = await git(["diff", ...target, "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--relative", "--", ...(specs.length ? specs.map(literal) : ["."])], { cwd: repo.cwd, quiet: req.target === "head" });
      } catch (e) {
        if (e instanceof FolderError && e.code === "git_failed" && req.target === "head") return { text: "There are no commits yet, so there is nothing to compare with.", truncated: false };
        throw e;
      }
      const text = redactSecrets(visibleDiff(r.out));
      const c = clip(text === "" ? "No changes." : text);
      return { text: c.text, truncated: c.truncated || r.truncated };
    }
    case "log": {
      const n = typeof req.limit === "number" && Number.isFinite(req.limit) ? Math.min(100, Math.max(1, Math.floor(req.limit))) : 20;
      let r;
      try {
        r = await git(["log", `-n${n}`, "--no-color", "--no-ext-diff", "--date=short", "--format=%h %ad %an: %s", "--", ...(specs.length ? specs.map(literal) : ["."])], { cwd: repo.cwd, quiet: true });
      } catch (e) {
        if (e instanceof FolderError && e.code === "git_failed") return { text: "No commits yet.", truncated: false };
        throw e;
      }
      const c = clip(redactSecrets(r.out.trim() === "" ? "No commits yet." : r.out));
      return { text: c.text, truncated: c.truncated || r.truncated };
    }
    case "show": {
      if (typeof req.rev !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,99}$/.test(req.rev)) throw new FolderError("bad_request", "rev must be a commit, branch or tag name like HEAD, HEAD~1, main or a commit hash.");
      // Only commits: `git show <blob>` would print any file in the repository, hidden ones included.
      let sha: string;
      try {
        sha = (await git(["rev-parse", "--verify", "--quiet", `${req.rev}^{commit}`], { cwd: repo.cwd, quiet: true })).out.trim();
      } catch {
        throw new FolderError("not_found", "That commit doesn't exist.");
      }
      if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new FolderError("not_found", "That commit doesn't exist.");
      const r = await git(["show", sha, "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--relative", "--date=short", "--format=commit %h%nAuthor: %an%nDate:   %ad%n%n%B", "--", ...(specs.length ? specs.map(literal) : ["."])], { cwd: repo.cwd });
      const c = clip(redactSecrets(visibleDiff(r.out)));
      return { text: c.text, truncated: c.truncated || r.truncated };
    }
    default:
      throw new FolderError("bad_request", "Unknown git request.");
  }
}

// ------------------------------------------------------------------ writes (proposals)

type ChangeReq = { id?: unknown; action?: unknown; paths?: unknown; message?: unknown; name?: unknown };

const countLines = (diff: string) => {
  let added = 0;
  let removed = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) added++;
    else if (l.startsWith("-") && !l.startsWith("---")) removed++;
  }
  return { added, removed };
};

/** `git add -- a b c` as shown to the host (long lists are cut for the display, never for the run). */
function shownCommand(parts: string[], files: string[]): string {
  const shown = files.slice(0, 30).map((f) => (/^[\w./@+-]+$/.test(f) ? f : JSON.stringify(f)));
  return `${parts.join(" ")} -- ${shown.join(" ")}${files.length > 30 ? ` … (+${files.length - 30} more)` : ""}`;
}

/** The repository for a write that names no path: the one shared folder. */
async function soleRepo(items: Item[]): Promise<Repo> {
  const dirs = items.filter((i) => i.kind === "dir");
  if (dirs.length !== 1) throw new FolderError("bad_request", "Several folders are shared, so this cannot tell which repository you mean. Ask the host to share one folder.");
  return repoOf(dirs[0]!.abs);
}

const stale = () => new FolderError("stale", "The repository changed after the host looked at it. Check it again and propose the action again.");

/** Works out a git write without changing anything. Throws a FolderError whose message the AI and the chat can see. */
export async function stageGitChange(items: Item[], req: ChangeReq): Promise<GitStaged> {
  const id = req.id as string;
  switch (req.action) {
    case "add":
    case "restore":
      return stageAddOrRestore(items, id, req.action, req.paths);
    case "commit":
      return stageCommit(items, id, req.message);
    case "branch":
      return stageBranch(items, id, req.name);
    default:
      throw new FolderError("bad_request", "Unknown git action.");
  }
}

async function stageAddOrRestore(items: Item[], id: string, action: "add" | "restore", pathsIn: unknown): Promise<GitStaged> {
  if (!Array.isArray(pathsIn) || pathsIn.length === 0 || pathsIn.length > L.gitPaths) throw new FolderError("bad_request", `Give 1 to ${L.gitPaths} paths.`);
  // Every path must be in the same shared folder; "" (the top) means everything that changed in it.
  let root: string | null = null;
  const specs: string[] = [];
  for (const p of pathsIn) {
    if (typeof p !== "string") throw new FolderError("bad_request", "Paths must be text.");
    const t = resolve(items, p);
    if (t === "top") {
      const dirs = items.filter((i) => i.kind === "dir");
      if (dirs.length !== 1) throw new FolderError("bad_request", "Several folders are shared. Give paths inside the one you mean.");
      root ??= dirs[0]!.abs;
      if (root !== dirs[0]!.abs) throw new FolderError("bad_request", "All paths must be in the same shared folder.");
      specs.push(".");
      continue;
    }
    if (t.single) throw new FolderError("no_repo", "A single shared file is not in a git repository the AI can use.");
    root ??= t.root;
    if (root !== t.root) throw new FolderError("bad_request", "All paths must be in the same shared folder.");
    const rel = t.start.join("/");
    if (rel !== "" && hiddenPath(rel, true)) throw new FolderError("excluded", "That path is hidden from the shared folder (secrets, keys, build output and similar are never shared).");
    specs.push(rel === "" ? "." : rel);
  }
  const repo = await repoOf(root!);
  const wanted = (e: GitStatusFile) => (action === "add" ? e.worktree !== " " : e.worktree === "M" || e.worktree === "D");
  const st = await statusEntries(repo, specs);
  // Only plain files: a link would put a path from the host's computer into the repository (git stores where it points).
  const plain = async (rel: string) => (await lstat(join(repo.cwd, rel)).catch(() => null))?.isSymbolicLink() !== true;
  const files: string[] = [];
  for (const e of st.files.filter(wanted)) if (action === "restore" || (await plain(e.path))) files.push(e.path);
  if (files.length === 0) throw new FolderError("nothing", action === "add" ? "Nothing to add: no changed or new files there (hidden files and ignored files are left out)." : "Nothing to restore: no modified or deleted tracked files there.");
  if (files.length > 200) throw new FolderError("too_large", "That is more than 200 files. Name a smaller folder or fewer files.");

  const stateOf = async () => sha256((await statusEntries(repo, specs)).files.filter(wanted).map((e) => `${e.index}${e.worktree} ${e.path}`).join("\0"));
  const diffOf = async () => redactSecrets(visibleDiff((await git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--relative", "--", ...files.map(literal)], { cwd: repo.cwd, maxChars: 400_000 })).out));
  let preview: string;
  let seal: string;
  if (action === "add") {
    const by = new Map(st.files.map((e) => [e.path, e]));
    preview = files.map((f) => `+${by.get(f)!.worktree === "?" ? "new" : "modified"}  ${f}`).join("\n");
    seal = await stateOf();
  } else {
    const d = await diffOf();
    preview = d;
    seal = sha256(d);
  }
  const command = shownCommand(action === "add" ? ["git", "add"] : ["git", "restore", "--worktree"], files);
  const text = clip(preview, L.diffChars);
  const { added, removed } = action === "add" ? { added: files.length, removed: 0 } : countLines(preview);
  return {
    id,
    git: true,
    change: { id, kind: "git", path: `git ${action}`, command, destructive: action === "restore", created: false, added, removed, diff: text.text, cut: text.truncated },
    apply: async () => {
      const now = action === "add" ? await stateOf() : sha256(await diffOf());
      if (now !== seal) throw stale();
      await git(action === "add" ? ["add", "--", ...files.map(literal)] : ["restore", "--worktree", "--", ...files.map(literal)], { cwd: repo.cwd, locks: true });
      return { command, output: `${action === "add" ? "Added" : "Restored"} ${files.length} ${files.length === 1 ? "file" : "files"}.` };
    },
  };
}

async function stageCommit(items: Item[], id: string, messageIn: unknown): Promise<GitStaged> {
  if (typeof messageIn !== "string") throw new FolderError("bad_request", "Give a commit message.");
  const message = messageIn.replaceAll("\r\n", "\n").trim();
  // eslint-disable-next-line no-control-regex
  if (message === "" || message.length > L.gitMessageChars || /[\u0000]/.test(message)) throw new FolderError("bad_request", `The commit message must be 1 to ${L.gitMessageChars} characters of text.`);
  if (redactSecrets(message) !== message) throw new FolderError("secrets", "The commit message contains something that looks like a secret, so it was not used.");
  const repo = await soleRepo(items);

  const stagedNames = async () => {
    const r = await git(["diff", "--cached", "--name-only", "-z", "--no-renames"], { cwd: repo.cwd });
    return r.out.split("\0").filter(Boolean);
  };
  const names = await stagedNames();
  if (names.length === 0) throw new FolderError("nothing", "Nothing is staged. Stage files with git_add first.");
  // Only what is inside the shared folder and not hidden may go into a commit the AI proposes.
  const outside = names.filter((n) => inside(repo, n) === null);
  if (outside.length) throw new FolderError("excluded", "Some staged changes are outside the shared folder, so the AI cannot commit. The host can commit those by hand.");
  const hidden = names.filter((n) => hiddenPath(inside(repo, n)!));
  if (hidden.length) throw new FolderError("excluded", "Some staged files are hidden kinds (secrets, keys, build output), so the AI cannot commit. The host can commit those by hand.");

  const identity = async () => {
    const get = async (k: string) => {
      try {
        return (await git(["config", "--get", k], { cwd: repo.cwd, trusted: true })).out.trim();
      } catch {
        return "";
      }
    };
    const [name, email] = [await get("user.name"), await get("user.email")];
    if (!name || !email) throw new FolderError("git_failed", "Git has no name and email set on the host's computer, so it cannot commit. The host can set them with git config.");
    return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
  };
  await identity();

  const stateOf = async () => {
    let head = "none";
    try {
      head = (await git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repo.cwd, quiet: true })).out.trim();
    } catch {
      /* no commits yet */
    }
    const raw = (await git(["diff", "--cached", "--raw", "-z", "--no-renames", "--abbrev=40"], { cwd: repo.cwd })).out;
    return sha256(`${head}\0${raw}`);
  };
  const seal = await stateOf();
  const diff = redactSecrets(visibleDiff((await git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--relative", "--"], { cwd: repo.cwd, maxChars: 400_000 })).out));
  const header = ["@@ commit message @@", ...message.split("\n").map((l) => ` ${l}`), ""].join("\n");
  const body = clip(`${header}\n${diff}`, L.diffChars);
  const command = `git commit -m ${JSON.stringify(message.length > 200 ? `${message.slice(0, 200)}…` : message)}`;
  return {
    id,
    git: true,
    change: { id, kind: "git", path: "git commit", command, created: false, ...countLines(diff), diff: body.text, cut: body.truncated },
    apply: async () => {
      if ((await stateOf()) !== seal) throw stale();
      const env = await identity();
      const r = await git(["commit", "--no-verify", "--no-gpg-sign", "--no-post-rewrite", "-m", message], { cwd: repo.cwd, env, locks: true });
      return { command, output: redactSecrets(r.out).slice(0, 500) };
    },
  };
}

async function stageBranch(items: Item[], id: string, nameIn: unknown): Promise<GitStaged> {
  if (typeof nameIn !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(nameIn) || nameIn.includes("..") || nameIn.endsWith("/") || nameIn.endsWith(".lock")) {
    throw new FolderError("bad_request", "Branch names use letters, digits and . _ / - only, and start with a letter or digit.");
  }
  const name = nameIn;
  const repo = await soleRepo(items);
  try {
    await git(["check-ref-format", "--branch", name], { cwd: repo.cwd });
  } catch {
    throw new FolderError("bad_request", "That is not a valid branch name.");
  }
  const head = async () => {
    try {
      return (await git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repo.cwd, quiet: true })).out.trim();
    } catch {
      throw new FolderError("nothing", "There are no commits yet, so there is nothing to branch from.");
    }
  };
  const at = await head();
  const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { cwd: repo.cwd, quiet: true }).then(
    () => true,
    () => false,
  );
  if (exists) throw new FolderError("exists", "A branch with that name already exists.");
  const command = `git switch -c ${name}`;
  return {
    id,
    git: true,
    change: { id, kind: "git", path: "git branch", command, created: true, added: 0, removed: 0, diff: `@@ new branch @@\n+${name}\n from ${at.slice(0, 10)}`, cut: false },
    apply: async () => {
      if ((await head()) !== at) throw stale();
      await git(["switch", "-c", name], { cwd: repo.cwd, locks: true });
      return { command, output: `Switched to a new branch ${name}.` };
    },
  };
}
