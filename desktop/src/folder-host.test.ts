import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { answer, FolderConn, serverSocketUrl, type FolderState } from "./folder-host.ts";

let root = "";
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "mc-host-")));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "hello\nneedle\n");
  writeFileSync(join(root, ".env"), "SECRET=1");
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
  test("list, read, search", async () => {
    const list = await answer(root, { id: "1", op: "list", path: "" });
    assert.ok(list?.ok && (list.result as { entries: { name: string }[] }).entries.some((e) => e.name === "src"));
    const read = await answer(root, { id: "2", op: "read", path: "src/a.ts" });
    assert.ok(read?.ok && (read.result as { text: string }).text === "hello\nneedle");
    const search = await answer(root, { id: "3", op: "search", query: "needle" });
    assert.ok(search?.ok && (search.result as { matches: unknown[] }).matches.length === 1);
  });
  test("errors carry a code and no local paths", async () => {
    for (const req of [
      { id: "a", op: "read", path: ".env" },
      { id: "b", op: "read", path: "../x" },
      { id: "c", op: "read", path: "missing.txt" },
      { id: "d", op: "list", path: "src/a.ts" },
      { id: "e", op: "nope" },
    ]) {
      const res = await answer(root, req);
      assert.ok(res && !res.ok);
      assert.ok(!JSON.stringify(res).includes(root));
    }
  });
  test("drops requests without a usable id", async () => {
    assert.equal(await answer(root, { op: "list", path: "" }), null);
    assert.equal(await answer(root, { id: "x".repeat(100), op: "list", path: "" }), null);
    assert.equal(await answer(root, null), null);
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
    const conn = new FolderConn({ projectId: "p1", wsUrl: `ws://127.0.0.1:${port}`, getToken: () => "tok", root, onState: (s) => states.push(s) });
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
    const conn = new FolderConn({ projectId: "p2", wsUrl: `ws://127.0.0.1:${port}`, getToken: () => "tok", root, onState: () => undefined });
    await until(() => conn.state === "rejected");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(sockets.length, before + 1);
    assert.equal(conn.state, "rejected");
    conn.close();
  });

  test("ignores requests before the server said ready and junk frames", async () => {
    respond = () => undefined;
    const conn = new FolderConn({ projectId: "p3", wsUrl: `ws://127.0.0.1:${port}`, getToken: () => "tok", root, onState: () => undefined });
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
