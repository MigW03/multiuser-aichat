import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import type { ExecResult } from "@mc/shared";
import { Approvals } from "./folder-approvals.ts";
import { cleanOutput, execEnv, execute, stageExec } from "./folder-exec.ts";
import { FolderError } from "./folder-fs.ts";
import { nameItems, type Item } from "./folder-items.ts";

const posix = process.platform !== "win32";
const fails = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof FolderError && e.code === code, `expected ${code}`);
};

let base = "";
let root = "";
let items: Item[] = [];
let n = 0;
/** A folder inside the share starts with the shared folder's name. Escapes and absolute paths stay as they are. */
const at = (path: string) => (path.startsWith("/") || path.startsWith("..") ? path : `${items[0]!.name}/${path}`);
const stage = (command: string, extra: { workdir?: string; timeoutSec?: number; description?: string; [k: string]: unknown } = {}) => stageExec(items, { id: `x${++n}`, command, ...extra, ...(extra.workdir ? { workdir: at(extra.workdir) } : {}) });
const FAKE_TOKEN = ["sk", "ant", "api03", "x".repeat(40)].join("-");

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mc-exec-")));
  root = join(base, "app");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(base, "outside"));
  symlinkSync(join(base, "outside"), join(root, "linkdir"));
  writeFileSync(join(root, "hello.txt"), "hello\n");
  items = nameItems([{ abs: root, kind: "dir" }]);
});

describe("environment and output", { skip: !posix }, () => {
  test("the host's tokens and keys are not passed on", () => {
    const env = execEnv({ PATH: "/usr/bin", HOME: "/h", GITHUB_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "k", OPENAI_API_KEY: "o", SSH_AUTH_SOCK: "/s", NPM_TOKEN: "n", LANG: "C" });
    assert.deepEqual(Object.keys(env).sort(), ["CI", "EDITOR", "GIT_EDITOR", "GIT_PAGER", "GIT_TERMINAL_PROMPT", "HOME", "LANG", "NO_COLOR", "PAGER", "PATH", "TERM"].sort());
  });

  test("a command cannot see them either", async () => {
    process.env.MC_TEST_SECRET_TOKEN = "super-secret-value";
    try {
      const r = await execute("env; echo ---; echo \"[$MC_TEST_SECRET_TOKEN]\"", root, 10_000);
      assert.ok(!r.output.includes("super-secret-value"));
      assert.match(r.output, /\[\]/);
    } finally {
      delete process.env.MC_TEST_SECRET_TOKEN;
    }
  });

  test("terminal escapes and control characters are removed, secrets are masked", () => {
    assert.equal(cleanOutput("\u001b[31mred\u001b[0m \u001b]0;title\u0007ok\r\nnext\rback\u0000\u0007"), "red ok\nnext\nback");
    assert.equal(cleanOutput("a\u2028b"), "ab");
  });

  test("a printed token is masked", async () => {
    const r = await execute(`echo "key = ${FAKE_TOKEN}"`, root, 10_000);
    assert.match(r.output, /\[redacted secret\]/);
    assert.ok(!r.output.includes(FAKE_TOKEN));
  });
});

describe("running", { skip: !posix }, () => {
  test("stdout and stderr together, exit code, folder", async () => {
    const r = await execute("echo out; echo err 1>&2; pwd; exit 3", join(root, "src"), 10_000);
    assert.equal(r.exitCode, 3);
    assert.equal(r.timedOut, false);
    assert.match(r.output, /out\nerr\n.*\/src\n/);
    assert.equal(r.truncated, false);
  });

  test("standard input is closed, so a command that waits for input ends", async () => {
    const r = await execute("cat; echo done", root, 10_000);
    assert.match(r.output, /done/);
  });

  test("the time limit stops it and everything it started", async () => {
    const marker = join(base, "survivor");
    const t0 = Date.now();
    const r = await execute(`(sleep 30; touch ${marker}) & sleep 30`, root, 400);
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 5000);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(existsSync(marker), false);
  });

  test("something left running in the background is stopped when the command ends", async () => {
    const marker = join(base, "bg-survivor");
    await execute(`(sleep 1; touch ${marker}) > /dev/null 2>&1 & echo started`, root, 10_000);
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal(existsSync(marker), false);
  });

  test("long output keeps the start and the end", async () => {
    const r = await execute("i=0; while [ $i -lt 20000 ]; do echo \"line $i of the output\"; i=$((i+1)); done", root, 20_000);
    assert.equal(r.truncated, true);
    assert.match(r.output, /^line 0 of the output/);
    assert.match(r.output, /line 19999 of the output\n?$/);
    assert.ok(r.output.length < 51_000);
    assert.match(r.output, /omitted|output cut/);
  });

  test("a command that cannot be started is reported", async () => {
    await fails(execute("true", join(base, "does-not-exist"), 5000), "exec_failed");
  });
});

describe("stageExec", () => {
  test("shows the command as given, the folder and the limit; runs nothing", async () => {
    const s = await stage("touch should-not-exist.txt", { workdir: "src", timeoutSec: 30, description: "make a file\nwith a line break" });
    assert.equal(s.change.kind, "exec");
    assert.equal(s.change.command, "touch should-not-exist.txt");
    assert.equal(s.change.workdir, at("src"));
    assert.equal(s.change.timeoutSec, 30);
    assert.equal(s.change.note, "make a file with a line break");
    assert.equal(existsSync(join(root, "src/should-not-exist.txt")), false);
  });

  test("defaults and clamps the time limit", async () => {
    assert.equal((await stage("true")).change.timeoutSec, 120);
    assert.equal((await stage("true", { timeoutSec: 99999 })).change.timeoutSec, 600);
    assert.equal((await stage("true", { timeoutSec: 0 })).change.timeoutSec, 1);
  });

  test("bad commands", async () => {
    await fails(stage("   "), "bad_request");
    await fails(stage("echo a\0b"), "bad_request");
    await fails(stage("x".repeat(2501)), "bad_request");
    await fails(stage("echo \u202e hidden"), "bad_request");
    await fails(stage("echo a\u200bb"), "bad_request");
    await fails(stage("echo a\u001b[2Jb"), "bad_request");
    await fails(stage("echo a\rb"), "bad_request");
    await stage("echo a\n\techo b"); // line breaks and tabs are fine
    await fails(stageExec(items, { id: "y", command: 5 } as never), "bad_request");
  });

  test("the folder: inside the share, no links, nothing hidden", async () => {
    await fails(stage("ls", { workdir: "../outside" }), "invalid_path");
    await fails(stage("ls", { workdir: "/etc" }), "invalid_path");
    await fails(stage("ls", { workdir: "linkdir" }), "excluded");
    await fails(stage("ls", { workdir: ".git" }), "excluded");
    await fails(stage("ls", { workdir: "node_modules" }), "excluded");
    await fails(stage("ls", { workdir: "nope" }), "not_found");
    await fails(stage("ls", { workdir: "hello.txt" }), "not_a_directory");
  });

  test("runs only when told to, in the folder it showed", { skip: !posix }, async () => {
    const s = await stage("pwd; echo hi > made-by-command.txt", { workdir: "src" });
    assert.equal(existsSync(join(root, "src/made-by-command.txt")), false);
    let stopped = false;
    const r = await s.run(() => {
      stopped = true;
    });
    assert.equal(stopped, true, "a way to stop it was handed out");
    assert.match(r.output, /\/src\n/);
    assert.equal(readFileSync(join(root, "src/made-by-command.txt"), "utf8"), "hi\n");
  });

  test("a folder swapped for a link after the proposal is refused", { skip: !posix }, async () => {
    mkdirSync(join(root, "swap"));
    const s = await stage("touch pwned.txt", { workdir: "swap" });
    (await import("node:fs")).rmdirSync(join(root, "swap"));
    symlinkSync(join(base, "outside"), join(root, "swap"));
    await assert.rejects(s.run(() => undefined), (e: unknown) => e instanceof FolderError && e.code === "excluded");
    assert.equal(existsSync(join(base, "outside/pwned.txt")), false);
  });
});

describe("approvals for commands", { skip: !posix }, () => {
  const make = (confirm: () => Promise<boolean>, allowed = true) => {
    const events: string[] = [];
    const a = new Approvals({ onAdd: (v) => events.push(`add ${v.id}`), onGone: (_p, id) => events.push(`gone ${id}`), stillAllowed: (_p, kind) => allowed && kind === "exec", confirm });
    return { a, events };
  };

  test("the page's click alone does not run it; the native window decides", async () => {
    let asked = 0;
    const { a } = make(async () => (asked++, false));
    const s = await stage("echo ran > by-approval.txt");
    const p = a.propose("p", s, { askedBy: "Ana", readFiles: 0 });
    assert.equal(await a.decide("p", s.id, true), true);
    assert.equal(asked, 1);
    assert.equal(existsSync(join(root, "by-approval.txt")), false, "cancelling the window ran nothing");
    assert.equal(a.count("p"), 1, "and the card is still waiting");
    a.cancel("p", s.id);
    assert.equal(!(await p).ok, true);
  });

  test("confirmed: it runs once and the result comes back", async () => {
    const { a } = make(async () => true);
    const s = await stage("echo ran > by-approval.txt; echo output");
    const p = a.propose("p", s, { askedBy: "Ana", readFiles: 0 });
    await a.decide("p", s.id, true);
    const res = await p;
    assert.equal(res.ok, true);
    const result = (res as { result: ExecResult }).result;
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /output/);
    assert.equal(readFileSync(join(root, "by-approval.txt"), "utf8"), "ran\n");
    assert.equal(await a.decide("p", s.id, true), false, "a second click does nothing");
  });

  test("declined: nothing runs, and no native window is shown", async () => {
    let asked = 0;
    const { a } = make(async () => (asked++, true));
    const s = await stage("echo x > declined.txt");
    const p = a.propose("p", s, { askedBy: "A", readFiles: 0 });
    await a.decide("p", s.id, false);
    const r = await p;
    assert.equal(!r.ok && r.code, "denied");
    assert.equal(asked, 0);
    assert.equal(existsSync(join(root, "declined.txt")), false);
  });

  test("it expired while the window was open: it does not run", async () => {
    let release: (v: boolean) => void = () => undefined;
    const { a } = make(() => new Promise((res) => (release = res)));
    const s = await stage("echo x > late.txt");
    const p = a.propose("p", s, { askedBy: "A", readFiles: 0 });
    const deciding = a.decide("p", s.id, true);
    await new Promise((r) => setTimeout(r, 20));
    a.cancel("p", s.id);
    release(true);
    assert.equal(await deciding, false);
    assert.equal(!(await p).ok, true);
    assert.equal(existsSync(join(root, "late.txt")), false);
  });

  test("switched off before the click: nothing runs", async () => {
    const { a } = make(async () => true, false);
    const s = await stage("echo x > off.txt");
    const p = a.propose("p", s, { askedBy: "A", readFiles: 0 });
    await a.decide("p", s.id, true);
    const r = await p;
    assert.equal(!r.ok && r.code, "disabled");
    assert.equal(existsSync(join(root, "off.txt")), false);
  });

  test("Stop while it runs kills it; one command at a time", async () => {
    const { a } = make(async () => true);
    const s = await stage("sleep 30; echo x > never.txt", { timeoutSec: 60 });
    const p = a.propose("p", s, { askedBy: "A", readFiles: 0 });
    assert.equal(a.execBusy("p"), true);
    const deciding = a.decide("p", s.id, true);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(a.execBusy("p"), true, "still busy while running");
    a.cancel("p", s.id);
    await deciding;
    const res = (await p) as { ok: true; result: ExecResult };
    assert.equal(res.ok, true);
    assert.equal(res.result.signal, "SIGKILL");
    assert.equal(existsSync(join(root, "never.txt")), false);
    assert.equal(a.execBusy("p"), false);
  });

  test("closing the project (app quit, disconnect, switch-off) kills a running command", async () => {
    const { a } = make(async () => true);
    const s = await stage("sleep 30", { timeoutSec: 60 });
    const p = a.propose("p", s, { askedBy: "A", readFiles: 0 });
    void a.decide("p", s.id, true);
    await new Promise((r) => setTimeout(r, 300));
    a.closeProject("p", "off", "exec");
    const res = (await p) as { ok: true; result: ExecResult };
    assert.equal(res.result.signal, "SIGKILL");
  });
});
