import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import WebSocket from "ws";
import { createRelay, RelayError, type RelayDeps } from "./folder-relay.ts";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

const online: Record<string, boolean> = {};
const deps: RelayDeps = {
  authenticate: async (t) => (t === "host-token" ? "host" : t === "other-token" ? "other" : null),
  hostCheck: async (user, project) => (user === "host" ? (project === P1 || project === P2 ? { ok: true, name: "demo" } : { ok: false, reason: "not_linked" }) : { ok: false, reason: "not_host" }),
  setOnline: async (project, on) => {
    online[project] = on;
  },
};

let server: Server;
let relay: ReturnType<typeof createRelay>;
let port = 0;

before(async () => {
  relay = createRelay(deps, { requestMs: 400 });
  server = createServer((_req, res) => res.end("ok"));
  relay.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  relay.close();
  server.close();
});

/** Connects like the desktop app does and says hello. Resolves with the socket and the first message the server sends. */
async function connect(token: string, project: string, opts?: WebSocket.ClientOptions) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/folder-host`, opts);
  const messages: Record<string, unknown>[] = [];
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  ws.send(JSON.stringify({ type: "hello", token, projectId: project }));
  const first = async () => {
    for (let i = 0; i < 300 && messages.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    return messages[0];
  };
  return { ws, messages, closed, first };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), "timed out");
};

/** Answers every request with `reply(req)`. */
function answerWith(ws: WebSocket, reply: (req: Record<string, unknown>) => Record<string, unknown>) {
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as { type: string; req?: Record<string, unknown> };
    if (msg.type === "req" && msg.req) ws.send(JSON.stringify({ type: "res", res: { id: msg.req.id, ...reply(msg.req) } }));
  });
}

describe("connecting", () => {
  test("a bad token is refused", async () => {
    const c = await connect("nope", P1);
    assert.deepEqual(await c.first(), { type: "error", code: "unauthorized" });
    assert.equal(await c.closed, 4401);
    assert.equal(relay.isOnline(P1), false);
  });
  test("someone who is not the host is refused", async () => {
    const c = await connect("other-token", P1);
    assert.deepEqual(await c.first(), { type: "error", code: "not_host" });
    assert.equal(await c.closed, 4403);
  });
  test("a project without a folder is refused", async () => {
    const c = await connect("host-token", "33333333-3333-4333-8333-333333333333");
    assert.deepEqual(await c.first(), { type: "error", code: "not_linked" });
  });
  test("junk before hello closes the socket", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/folder-host`);
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "req", req: { id: "x", op: "list", path: "" } }));
    assert.equal(await closed, 1008);
  });
  test("browsers (anything with an Origin) and other paths are refused", async () => {
    await assert.rejects(new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/folder-host`, { origin: "https://evil.example" });
      ws.on("open", resolve);
      ws.on("error", reject);
    }), /403/);
    await assert.rejects(new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
      ws.on("open", resolve);
      ws.on("error", reject);
    }), /403/);
  });
});

describe("serving", () => {
  test("the host connects, goes online, answers, and goes offline on disconnect", async () => {
    const c = await connect("host-token", P1);
    assert.deepEqual(await c.first(), { type: "ready", name: "demo" });
    assert.equal(relay.isOnline(P1), true);
    assert.equal(online[P1], true);

    answerWith(c.ws, (req) => ({ ok: true, result: { path: req.path, entries: [{ name: "a.ts", type: "file", size: 3 }], truncated: false } }));
    const r = await relay.call(P1, { op: "list", path: "src" });
    assert.deepEqual(r.entries, [{ name: "a.ts", type: "file", size: 3 }]);

    c.ws.close();
    await c.closed;
    await until(() => !relay.isOnline(P1));
    await until(() => online[P1] === false);
    await assert.rejects(relay.call(P1, { op: "list", path: "" }), (e: unknown) => e instanceof RelayError && e.kind === "offline");
  });

  test("a host error comes back with its code and message", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    answerWith(c.ws, () => ({ ok: false, code: "excluded", message: "Hidden." }));
    await assert.rejects(relay.call(P1, { op: "read", path: ".env" }), (e: unknown) => e instanceof RelayError && e.kind === "host" && e.code === "excluded" && e.message === "Hidden.");
    c.ws.close();
    await until(() => !relay.isOnline(P1));
  });

  test("answers that break the rules are rejected, not passed on", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    const bad = [
      { ok: true, result: { path: "", entries: [{ name: "evil\nname", type: "file" }], truncated: false } },
      { ok: true, result: { path: "", entries: Array.from({ length: 501 }, (_, i) => ({ name: `f${i}`, type: "file" })), truncated: false } },
      { ok: true, result: "not an object" },
      { ok: true, result: { path: "", entries: [{ name: "a", type: "symlink" }], truncated: false } },
    ];
    let i = 0;
    answerWith(c.ws, () => bad[i++ % bad.length]!);
    for (let n = 0; n < bad.length; n++) {
      await assert.rejects(relay.call(P1, { op: "list", path: "" }), (e: unknown) => e instanceof RelayError && e.kind === "bad_answer");
    }
    c.ws.close();
    await until(() => !relay.isOnline(P1));
  });

  test("a read result must fit the limits", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    answerWith(c.ws, () => ({ ok: true, result: { path: "a", text: "x".repeat(200_000), startLine: 1, endLine: 1, totalLines: 1, truncated: false } }));
    await assert.rejects(relay.call(P1, { op: "read", path: "a" }), (e: unknown) => e instanceof RelayError && e.kind === "bad_answer");
    c.ws.close();
    await until(() => !relay.isOnline(P1));
  });

  test("an answer that never comes times out; unknown ids are ignored", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    c.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string };
      if (msg.type === "req") c.ws.send(JSON.stringify({ type: "res", res: { id: "not-a-pending-id", ok: true, result: {} } }));
    });
    await assert.rejects(relay.call(P1, { op: "list", path: "" }), (e: unknown) => e instanceof RelayError && e.kind === "timeout");
    c.ws.close();
    await until(() => !relay.isOnline(P1));
  });

  test("too many requests at once are turned away", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    const calls = Array.from({ length: 16 }, () => relay.call(P1, { op: "list", path: "" }).catch((e: unknown) => e));
    await assert.rejects(relay.call(P1, { op: "list", path: "" }), (e: unknown) => e instanceof RelayError && e.kind === "busy");
    await Promise.all(calls); // they time out
    c.ws.close();
    await until(() => !relay.isOnline(P1));
  });

  test("a new connection replaces the old one and the folder stays online", async () => {
    const a = await connect("host-token", P2);
    await a.first();
    const b = await connect("host-token", P2);
    await b.first();
    assert.equal(await a.closed, 4000);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(relay.isOnline(P2), true);
    assert.equal(online[P2], true);
    answerWith(b.ws, (req) => ({ ok: true, result: { matches: [], truncated: false, q: req.query } }));
    assert.deepEqual((await relay.call(P2, { op: "search", query: "x" })).matches, []);
    b.ws.close();
    await until(() => !relay.isOnline(P2));
  });

  test("a refreshed token for someone else ends the connection; one for the same person does not", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    c.ws.send(JSON.stringify({ type: "token", token: "host-token" }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(relay.isOnline(P1), true);
    c.ws.send(JSON.stringify({ type: "token", token: "other-token" }));
    assert.equal(await c.closed, 4401);
  });

  test("disconnect() ends the host's connection", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    relay.disconnect(P1);
    assert.equal(await c.closed, 4403);
    await until(() => !relay.isOnline(P1));
  });

  test("an oversized frame closes the socket", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    c.ws.send("x".repeat(2 * 1024 * 1024));
    assert.ok([1006, 1009].includes(await c.closed)); // too big: the server drops the connection
    await until(() => !relay.isOnline(P1));
  });
});

describe("sign-in age", () => {
  test("a connection whose token is never refreshed is closed", async () => {
    const short = createRelay(deps, { tokenMaxMs: 150, pingMs: 50 });
    const srv = createServer();
    short.attach(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const ws = new WebSocket(`ws://127.0.0.1:${(srv.address() as AddressInfo).port}/api/folder-host`);
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", token: "host-token", projectId: P1 }));
    assert.equal(await closed, 4401);
    short.close();
    srv.close();
  });
});
