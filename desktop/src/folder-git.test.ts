import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import type { GitStatusResult, GitTextResult } from "@mc/shared";
import { Approvals } from "./folder-approvals.ts";
import { FolderError } from "./folder-fs.ts";
import { gitRead, hiddenPath, stageGitChange } from "./folder-git.ts";
import { nameItems } from "./folder-items.ts";

const fails = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof FolderError && e.code === code, `expected ${code}`);
};
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
const FAKE_TOKEN = ["sk", "ant", "api03", "x".repeat(40)].join("-");

let base = "";
let repo = "";
let items = nameItems([]);
let n = 0;
const id = () => `g${++n}`;
const read = (req: object) => gitRead(items, req as never);
const change = (req: object) => stageGitChange(items, { id: id(), ...req } as never);

function makeRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.name", "Host Person");
  sh(dir, "config", "user.email", "host@example.com");
  return dir;
}

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mc-git-")));
  repo = makeRepo(join(base, "app"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "README.md"), "# app\n");
  writeFileSync(join(repo, ".gitignore"), "dist/\n");
  writeFileSync(join(repo, ".env"), "KEY=one\n");
  sh(repo, "add", "-f", "-A");
  sh(repo, "commit", "-q", "-m", "first commit");
  items = nameItems([{ abs: repo, kind: "dir" }]);
});

describe("hiddenPath", () => {
  test("hidden parts anywhere", () => {
    assert.equal(hiddenPath(".env"), true);
    assert.equal(hiddenPath("a/.git/config"), true);
    assert.equal(hiddenPath("node_modules/x/index.js"), true);
    assert.equal(hiddenPath("src/a.ts"), false);
  });
});

describe("reads", () => {
  test("status shows branch, changes and new files, never hidden ones", async () => {
    writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "src/new.ts"), "x\n");
    writeFileSync(join(repo, ".env"), "KEY=two\n"); // tracked and changed, but hidden
    writeFileSync(join(repo, ".env.local"), "X=1\n"); // untracked and hidden
    mkdirSync(join(repo, "dist"));
    writeFileSync(join(repo, "dist/out.js"), "ignored\n");
    const s = (await read({ sub: "status" })) as GitStatusResult;
    assert.equal(s.branch, "main");
    assert.deepEqual(s.files.map((f) => `${f.index}${f.worktree} ${f.path}`).sort(), [" M src/a.ts", "?? src/new.ts"]);
  });

  test("diff in three flavours, and hidden files' diffs are left out", async () => {
    const wt = (await read({ sub: "diff" })) as GitTextResult;
    assert.match(wt.text, /\+export const a = 2;/);
    assert.ok(!wt.text.includes("KEY="), "the .env diff is not shown");
    assert.ok(!(await read({ sub: "diff", target: "staged" }) as GitTextResult).text.includes("export"));
    sh(repo, "add", "src/a.ts");
    assert.match(((await read({ sub: "diff", target: "staged" })) as GitTextResult).text, /\+export const a = 2;/);
    assert.match(((await read({ sub: "diff", target: "head" })) as GitTextResult).text, /\+export const a = 2;/);
    sh(repo, "restore", "--staged", "src/a.ts");
  });

  test("a hidden file whose name git has to quote is left out too", async () => {
    // .env.x"y  (a double quote in the name makes git quote the header)
    const odd = '.env.x"y';
    writeFileSync(join(repo, odd), "SECRET_VALUE=1\n");
    sh(repo, "add", "-f", "--", odd);
    const d = ((await read({ sub: "diff", target: "staged" })) as GitTextResult).text;
    assert.ok(!d.includes("SECRET_VALUE"), "quoted-name diff is left out");
    sh(repo, "reset", "-q", "HEAD", "--", odd);
    rmSync(join(repo, odd));
  });

  test("diff masks secrets", async () => {
    writeFileSync(join(repo, "README.md"), `# app\nkey = ${FAKE_TOKEN}\n`);
    const d = ((await read({ sub: "diff", path: "README.md" })) as GitTextResult).text;
    assert.match(d, /\[redacted secret\]/);
    assert.ok(!d.includes(FAKE_TOKEN));
    sh(repo, "checkout", "--", "README.md");
  });

  test("log and show", async () => {
    assert.match(((await read({ sub: "log" })) as GitTextResult).text, /first commit/);
    const shown = ((await read({ sub: "show", rev: "HEAD" })) as GitTextResult).text;
    assert.match(shown, /first commit/);
    assert.match(shown, /src\/a\.ts/);
    assert.ok(!shown.includes("KEY=one"), "the hidden file's contents are not shown");
  });

  test("show only shows commits, never a file's contents", async () => {
    const blob = sh(repo, "rev-parse", "HEAD:.env").trim();
    await fails(read({ sub: "show", rev: blob }), "not_found");
    await fails(read({ sub: "show", rev: "HEAD:.env" }), "bad_request");
    await fails(read({ sub: "show", rev: "--output=/tmp/x" }), "bad_request");
    await fails(read({ sub: "show", rev: "nonexistent" }), "not_found");
  });

  test("a path limits the result and must be allowed", async () => {
    const d = ((await read({ sub: "diff", path: "src" })) as GitTextResult).text;
    assert.match(d, /a\.ts/);
    await fails(read({ sub: "diff", path: ".git" }), "excluded");
    await fails(read({ sub: "diff", path: "../x" }), "invalid_path");
    await fails(read({ sub: "diff", path: "nope/never" }), "not_found");
    await fails(read({ sub: "nope" }), "bad_request");
  });

  test("a folder that is not a repository", async () => {
    const plain = join(base, "plain");
    mkdirSync(plain);
    const other = nameItems([{ abs: plain, kind: "dir" }]);
    await fails(gitRead(other, { sub: "status" } as never), "no_repo");
  });

  test("a repository whose config would run programs is refused, and nothing runs", async () => {
    const evil = makeRepo(join(base, "evil"));
    const marker = join(base, "evil-ran");
    const script = join(base, "evil.sh");
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(evil, "a.txt"), "x\n");
    writeFileSync(join(evil, ".gitattributes"), "*.txt filter=bad\n");
    sh(evil, "config", "filter.bad.clean", script);
    const it = nameItems([{ abs: evil, kind: "dir" }]);
    await fails(gitRead(it, { sub: "status" } as never), "git_unsafe");
    assert.equal(existsSync(marker), false);
  });

  test("fsmonitor and hooks from the repository's config do not run", async () => {
    const r = makeRepo(join(base, "mon"));
    const marker = join(base, "mon-ran");
    const script = join(base, "mon.sh");
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(r, "a.txt"), "x\n");
    sh(r, "config", "core.fsmonitor", script);
    mkdirSync(join(r, ".git/hooks"), { recursive: true });
    const hook = join(r, ".git/hooks/pre-commit");
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(hook, 0o755);
    const it = nameItems([{ abs: r, kind: "dir" }]);
    await gitRead(it, { sub: "status" } as never);
    assert.equal(existsSync(marker), false, "fsmonitor ran");
    const add = await stageGitChange(it, { id: id(), action: "add", paths: ["a.txt"] });
    await add.apply();
    const commit = await stageGitChange(it, { id: id(), action: "commit", message: "hello" });
    await commit.apply();
    assert.equal(existsSync(marker), false, "a hook ran");
    assert.match(sh(r, "log", "--format=%s"), /hello/);
  });
});

describe("writes", () => {
  test("add: lists what it will add, skips hidden and ignored, and is sealed to the state", async () => {
    const s = await change({ action: "add", paths: [""] });
    assert.equal(s.change.kind, "git");
    assert.match(s.change.command!, /^git add -- /);
    assert.match(s.change.diff, /src\/new\.ts/);
    assert.match(s.change.diff, /src\/a\.ts/);
    assert.ok(!s.change.diff.includes(".env") && !s.change.diff.includes("dist/"));
    assert.equal(sh(repo, "diff", "--cached", "--name-only").trim(), "");
    writeFileSync(join(repo, "src/surprise.ts"), "appeared after the diff was made\n");
    await assert.rejects(s.apply(), (e: unknown) => e instanceof FolderError && e.code === "stale");
    const again = await change({ action: "add", paths: ["src/a.ts", "src/new.ts"] });
    const done = await again.apply();
    assert.match(done.output, /Added 2 files/);
    assert.deepEqual(sh(repo, "diff", "--cached", "--name-only").trim().split("\n").sort(), ["src/a.ts", "src/new.ts"]);
  });

  test("add leaves symlinks out", async () => {
    const link = join(repo, "src/link.ts");
    symlinkSync("/etc/hosts", link);
    const s = await change({ action: "add", paths: ["src"] });
    assert.ok(!s.change.diff.includes("link.ts"), "a symlink is not offered");
    assert.ok(!s.change.command!.includes("link.ts"));
    await fails(change({ action: "add", paths: ["src/link.ts"] }), "nothing");
    rmSync(link);
  });

  test("add refuses hidden paths and empty results", async () => {
    await fails(change({ action: "add", paths: [".env"] }), "excluded");
    await fails(change({ action: "add", paths: [".git/config"] }), "excluded");
    await fails(change({ action: "add", paths: ["../x"] }), "invalid_path");
    await fails(change({ action: "add", paths: ["dist"] }), "excluded");
    await fails(change({ action: "add", paths: [] }), "bad_request");
    await fails(change({ action: "add", paths: ["README.md"] }), "nothing");
  });

  test("commit: shows the message and the diff, runs only when applied, with the host's name", async () => {
    const s = await change({ action: "commit", message: "Change a, add new\n\nLonger text." });
    assert.equal(s.change.path, "git commit");
    assert.match(s.change.diff, /@@ commit message @@\n Change a, add new/);
    assert.match(s.change.diff, /\+export const a = 2;/);
    assert.equal(sh(repo, "log", "--format=%s", "-1").trim(), "first commit");
    const done = await s.apply();
    assert.match(done.output, /Change a, add new/);
    assert.equal(sh(repo, "log", "--format=%an <%ae> %s", "-1").trim(), "Host Person <host@example.com> Change a, add new");
  });

  test("commit refuses a message with a secret, nothing staged, and a repository that changed", async () => {
    await fails(change({ action: "commit", message: `token ${FAKE_TOKEN}` }), "secrets");
    await fails(change({ action: "commit", message: "  " }), "bad_request");
    await fails(change({ action: "commit", message: "empty" }), "nothing");
    writeFileSync(join(repo, "src/surprise.ts"), "one\n");
    sh(repo, "add", "src/surprise.ts");
    const s = await change({ action: "commit", message: "surprise" });
    writeFileSync(join(repo, "src/surprise.ts"), "two\n");
    sh(repo, "add", "src/surprise.ts");
    await assert.rejects(s.apply(), (e: unknown) => e instanceof FolderError && e.code === "stale");
    sh(repo, "commit", "-q", "-m", "by hand");
  });

  test("commit refuses staged hidden files", async () => {
    writeFileSync(join(repo, ".env"), "KEY=three\n");
    sh(repo, "add", "-f", ".env");
    await fails(change({ action: "commit", message: "oops" }), "excluded");
    sh(repo, "reset", "-q", "HEAD", ".env");
    sh(repo, "checkout", "--", ".env");
  });

  test("commit refuses staged changes outside the shared folder", async () => {
    const sub = nameItems([{ abs: join(repo, "src"), kind: "dir" }]);
    writeFileSync(join(repo, "README.md"), "# changed outside the share\n");
    sh(repo, "add", "README.md");
    await assert.rejects(stageGitChange(sub, { id: id(), action: "commit", message: "x" }), (e: unknown) => e instanceof FolderError && e.code === "excluded");
    sh(repo, "reset", "-q", "HEAD", "README.md");
    sh(repo, "checkout", "--", "README.md");
  });

  test("restore: shows what will be thrown away, flagged destructive, sealed", async () => {
    writeFileSync(join(repo, "src/a.ts"), "export const a = 99;\n");
    const s = await change({ action: "restore", paths: ["src/a.ts"] });
    assert.equal(s.change.destructive, true);
    assert.match(s.change.diff, /\+export const a = 99;/);
    assert.match(s.change.command!, /^git restore --worktree -- src\/a\.ts$/);
    writeFileSync(join(repo, "src/a.ts"), "export const a = 100;\n");
    await assert.rejects(s.apply(), (e: unknown) => e instanceof FolderError && e.code === "stale");
    const again = await change({ action: "restore", paths: ["src/a.ts"] });
    await again.apply();
    assert.equal(readFileSync(join(repo, "src/a.ts"), "utf8"), "export const a = 2;\n");
    await fails(change({ action: "restore", paths: ["src/a.ts"] }), "nothing");
    await fails(change({ action: "restore", paths: [".env"] }), "excluded");
  });

  test("branch: new names only, sealed to HEAD", async () => {
    const s = await change({ action: "branch", name: "feature/ai-change" });
    assert.equal(s.change.command, "git switch -c feature/ai-change");
    assert.equal(sh(repo, "branch", "--show-current").trim(), "main");
    await s.apply();
    assert.equal(sh(repo, "branch", "--show-current").trim(), "feature/ai-change");
    await fails(change({ action: "branch", name: "feature/ai-change" }), "exists");
    for (const bad of ["-bad", "a..b", "x y", "x;rm", "", "a/", "x.lock", "--detach"]) await fails(change({ action: "branch", name: bad }), "bad_request");
    sh(repo, "switch", "-q", "main");
  });

  test("an unknown action and a bad id", async () => {
    await fails(change({ action: "push" }), "bad_request");
    await fails(change({ action: "reset" }), "bad_request");
  });
});

describe("approvals for git", () => {
  const hooks = (allowed = true) => ({ onAdd: () => undefined, onGone: () => undefined, stillAllowed: (_p: string, kind: "files" | "git") => allowed && kind === "git" });

  test("nothing runs until the host approves; approving runs it once and returns the command", async () => {
    writeFileSync(join(repo, "src/b.ts"), "b\n");
    const a = new Approvals(hooks());
    const s = await change({ action: "add", paths: ["src/b.ts"] });
    const pending = a.propose("p", s, { askedBy: "Ana", readFiles: 1 });
    assert.equal(sh(repo, "diff", "--cached", "--name-only").trim(), "");
    await a.decide("p", s.id, true);
    const res = await pending;
    assert.equal(res.ok, true);
    assert.match(JSON.stringify(res), /git add -- src\/b\.ts/);
    assert.equal(sh(repo, "diff", "--cached", "--name-only").trim(), "src/b.ts");
    sh(repo, "reset", "-q", "HEAD", "src/b.ts");
  });

  test("declined, and switched off before the click: nothing runs", async () => {
    const s = await change({ action: "add", paths: ["src/b.ts"] });
    const a = new Approvals(hooks());
    const p = a.propose("p", s, { askedBy: "A", readFiles: 0 });
    await a.decide("p", s.id, false);
    assert.equal(!(await p).ok, true);
    const s2 = await change({ action: "add", paths: ["src/b.ts"] });
    const off = new Approvals(hooks(false));
    const p2 = off.propose("p", s2, { askedBy: "A", readFiles: 0 });
    await off.decide("p", s2.id, true);
    const r = await p2;
    assert.equal(!r.ok && r.code, "disabled");
    assert.equal(sh(repo, "diff", "--cached", "--name-only").trim(), "");
  });

  test("closeProject can withdraw only one kind", async () => {
    const s = await change({ action: "add", paths: ["src/b.ts"] });
    const a = new Approvals(hooks());
    const p = a.propose("p", s, { askedBy: "A", readFiles: 0 });
    a.closeProject("p", "files off", "files");
    assert.equal(a.count("p"), 1);
    a.closeProject("p", "git off", "git");
    assert.equal(a.count("p"), 0);
    assert.equal(!(await p).ok, true);
  });
});
