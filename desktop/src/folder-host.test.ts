import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { globFiles, grepFiles } from "./folder-fs.ts";
import { workerSearch } from "./folder-grep.ts";
import { FolderConn, serverSocketUrl, type FolderState } from "./folder-host.ts";
import { answer, nameItems, summaryName, type Item, type Search } from "./folder-items.ts";

const grep: Search = { glob: (t, p, o) => globFiles(t, p, o), grep: (t, p, o) => grepFiles(t, p, o) };

let root = "";
let items: Item[] = [];
let multi: Item[] = [];
before(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mc-host-")));
  root = join(base, "my-app");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "hello\nneedle\n");
  writeFileSync(join(root, ".env"), "SECRET=1");
  mkdirSync(join(base, "other/my-app"), { recursive: true });
  writeFileSync(join(base, "other/my-app/b.ts"), "needle too\n");
  writeFileSync(join(base, "notes.md"), "# Notes\nneedle three\n");
  items = nameItems([{ abs: root, kind: "dir" }]);
  multi = nameItems([
    { abs: root, kind: "dir" },
    { abs: join(base, "notes.md"), kind: "file" },
    { abs: join(base, "other/my-app"), kind: "dir" },
  ]);
});

describe("server addresses", () => {
  test("only the chat server", () => {
    assert.equal(serverSocketUrl("https://mc.fly.dev", true), "wss://mc.fly.dev/api/folder-host");
    assert.equal(serverSocketUrl("https://evil.example.com", true), null);
    assert.equal(serverSocketUrl("https://fly.dev.evil.com", false), null);
    assert.equal(serverSocketUrl("http://mc.fly.dev", true), null);
    assert.equal(serverSocketUrl("http://localhost:8787", true), null);
    assert.equal(serverSocketUrl("http://localhost:8787", false), "ws://localhost:8787/api/folder-host");
    assert.equal(serverSocketUrl("http://127.0.0.1:8787", false), "ws://127.0.0.1:8787/api/folder-host");
    assert.equal(serverSocketUrl("not a url", false), null);
  });
});

describe("answer", () => {
  test("one folder is shared as is: list, read, glob, grep", async () => {
    const list = await answer(items, { id: "1", op: "list", path: "" }, grep);
    assert.ok(list?.ok && (list.result as { entries: { name: string }[] }).entries.some((e) => e.name === "src"));
    const read = await answer(items, { id: "2", op: "read", path: "src/a.ts" }, grep);
    assert.ok(read?.ok && (read.result as { text: string; path: string }).text === "hello\nneedle");
    const glob = await answer(items, { id: "3", op: "glob", pattern: "*.ts" }, grep);
    assert.deepEqual(glob?.ok && (glob.result as { paths: string[] }).paths, ["src/a.ts"]);
    const found = await answer(items, { id: "4", op: "grep", pattern: "needle" }, grep);
    assert.ok(found?.ok && (found.result as { matches: unknown[] }).matches.length === 1);
    assert.equal(summaryName(items), "my-app");
  });
  test("several items: a top level of names, each item under its own name", async () => {
    assert.deepEqual(multi.map((i) => i.name), ["my-app", "notes.md", "my-app (2)"]);
    assert.equal(summaryName(multi), "my-app + 2 more");
    const top = await answer(multi, { id: "1", op: "list", path: "" }, grep);
    assert.deepEqual(top?.ok && (top.result as { entries: { name: string; type: string }[] }).entries.map((e) => `${e.type}:${e.name}`), ["dir:my-app", "dir:my-app (2)", "file:notes.md"]);
    const read = await answer(multi, { id: "2", op: "read", path: "my-app/src/a.ts" }, grep);
    assert.equal(read?.ok && (read.result as { path: string }).path, "my-app/src/a.ts");
    const file = await answer(multi, { id: "3", op: "read", path: "notes.md" }, grep);
    assert.ok(file?.ok && (file.result as { text: string; path: string }).path === "notes.md");
    const inner = await answer(multi, { id: "4", op: "list", path: "my-app (2)" }, grep);
    assert.deepEqual(inner?.ok && (inner.result as { path: string; entries: { name: string }[] }).path, "my-app (2)");
    const all = await answer(multi, { id: "5", op: "grep", pattern: "needle" }, grep);
    assert.deepEqual(all?.ok && (all.result as { matches: { path: string }[] }).matches.map((m) => m.path).sort(), ["my-app (2)/b.ts", "my-app/src/a.ts", "notes.md"]);
    const glob = await answer(multi, { id: "6", op: "glob", pattern: "*.md" }, grep);
    assert.deepEqual(glob?.ok && (glob.result as { paths: string[] }).paths, ["notes.md"]);
    for (const bad of ["notes.md/x", "nope", "../x"]) {
      const res = await answer(multi, { id: "7", op: "read", path: bad }, grep);
      assert.ok(res && !res.ok, bad);
    }
    const nothing = await answer([], { id: "8", op: "list", path: "" }, grep);
    assert.ok(nothing && !nothing.ok);
  });
  test("glob and grep run in a worker that stops a regular expression that never ends", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "mc-redos-")));
    writeFileSync(join(base, "evil.txt"), `${"a".repeat(40)}!\n`);
    const slow = workerSearch(new URL("./folder-worker.test-boot.mjs", import.meta.url)); // tests run the TypeScript source
    const ok = await slow.grep([{ root: base, start: [], prefix: "" }], "a!", {});
    assert.equal(ok.matches.length, 1);
    assert.deepEqual((await slow.glob([{ root: base, start: [], prefix: "" }], "*.txt", {})).paths, ["evil.txt"]);
    const started = Date.now();
    await assert.rejects(slow.grep([{ root: base, start: [], prefix: "" }], "^(a+)+$", {}), (e: unknown) => (e as { code?: string }).code === "timeout");
    assert.ok(Date.now() - started < 20_000);
  });
  test("errors carry a code and no local paths", async () => {
    for (const req of [
      { id: "a", op: "read", path: ".env" },
      { id: "b", op: "read", path: "../x" },
      { id: "c", op: "read", path: "missing.txt" },
      { id: "d", op: "list", path: "src/a.ts" },
      { id: "e", op: "nope" },
    ]) {
      const res = await answer(items, req, grep);
      assert.ok(res && !res.ok);
      assert.ok(!JSON.stringify(res).includes(root));
    }
  });
  test("drops requests without a usable id", async () => {
    assert.equal(await answer(items, { op: "list", path: "" }, grep), null);
    assert.equal(await answer(items, { id: "x".repeat(100), op: "list", path: "" }, grep), null);
    assert.equal(await answer(items, null, grep), null);
  });
});

describe("connection", () => {
  let wss: WebSocketServer;
  let port = 0;
  let sockets: ServerSocket[] = [];
  const hellos: unknown[] = [];
  let respond: (ws: ServerSocket, msg: Record<string, unknown>) => void = () => undefined;

  before(async () => {
    wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((r) => wss.once("listening", r));
    port = (wss.address() as { port: number }).port;
    wss.on("connection", (ws) => {
      sockets.push(ws);
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as Record<string, unknown>;
        if (msg.type === "hello") {
          hellos.push(msg);
          ws.send(JSON.stringify({ type: "ready", name: "x" }));
        }
        respond(ws, msg);
      });
    });
  });
  after(() => wss.close());

  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond(), "timed out");
  };

  test("says hello, answers requests, reports state", async () => {
    const states: FolderState[] = [];
    const conn = new FolderConn({ projectId: "p1", wsUrl: `ws://127.0.0.1:${port}`, getToken: () => "tok", getItems: () => items, search: grep, onState: (s) => states.push(s) });
    await until(() => conn.state === "connected");
    assert.deepEqual(hellos.at(-1), { type: "hello", token: "tok", projectId: "p1" });

    const replies: Record<string, unknown>[] = [];
    respond = (_ws, msg) => msg.type === "res" && replies.push(msg.res as Record<string, unknown>);
    const ws = sockets.at(-1)!;
    ws.send(JSON.stringify({ type: "req", req: { id: "r1", op: "read", path: "src/a.ts" } }));
    ws.send(JSON.stringify({ type: "req", req: { id: "r2", op: "read", path: ".env" } }));
    await until(() => replies.length === 2);
    assert.equal(replies.find((r) => r.id === "r1")?.ok, true);
    assert.equal(replies.find((r) => r.id === "r2")?.ok, false);

    ws.send(JSON.stringify({ type: "token", x: 1 }));
    conn.tokenChanged();
    conn.close();
    assert.ok(states.includes("connected"));
  });

  test("a rejection stops reconnecting", async () => {
    const before = sockets.length;
    respond = (ws, msg) => {
      if (msg.type === "hello") {
        ws.send(JSON.stringify({ type: "error", code: "not_host" }));
        ws.close();
      }
    };
    const conn = new FolderConn({ projectId: "p2", wsUrl: `ws://127.0.0.1:${port}`, getToken: () => "tok", getItems: () => items, search: grep, onState: () => undefined });
    await until(() => conn.state === "rejected");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(sockets.length, before + 1);
    assert.equal(conn.state, "rejected");
    conn.close();
  });

  test("ignores requests before the server said ready and junk frames", async () => {
    respond = () => undefined;
    const conn = new FolderConn({ projectId: "p3", wsUrl: `ws://127.0.0.1:${port}`, getToken: () => "tok", getItems: () => items, search: grep, onState: () => undefined });
    await until(() => conn.state === "connected");
    const ws = sockets.at(-1)!;
    ws.send("not json");
    ws.send(JSON.stringify({ type: "req", req: "garbage" }));
    ws.send(JSON.stringify({ type: "req" }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(conn.state, "connected");
    conn.close();
  });
});
