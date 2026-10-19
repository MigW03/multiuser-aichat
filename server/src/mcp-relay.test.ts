import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import WebSocket from "ws";
import { createRelay } from "./folder-relay.ts";
import { RelayError } from "./folder-relay.ts";
import { createMcpRelay, MCP_PATH } from "./mcp-relay.ts";

const ANA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";

const mcp = createMcpRelay({ authenticate: async (t) => (t === "ana-token" ? ANA : t === "ben-token" ? BEN : null) }, { tokenMaxMs: 10_000 });
const folders = createRelay({ authenticate: async () => null, hostCheck: async () => ({ ok: false, reason: "not_host" }), setOnline: async () => undefined });
let server: Server;
let port = 0;

before(async () => {
  server = createServer((_req, res) => res.end("ok"));
  folders.attach(server, (path) => path === MCP_PATH);
  mcp.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  mcp.close();
  folders.close();
  server.close();
});

async function connect(token: string, opts?: WebSocket.ClientOptions, path = MCP_PATH) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, opts);
  const messages: Record<string, unknown>[] = [];
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  ws.send(JSON.stringify({ type: "hello", token }));
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

const answerWith = (ws: WebSocket, reply: (req: Record<string, unknown>) => Record<string, unknown>) =>
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as { type: string; req?: Record<string, unknown> };
    if (msg.type === "req" && msg.req) ws.send(JSON.stringify({ type: "res", res: { id: msg.req.id, ...reply(msg.req) } }));
  });

const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: "d", inputSchema: { type: "object", properties: {} }, ...extra });
const send = (c: { ws: WebSocket }, state: unknown) => c.ws.send(JSON.stringify({ type: "mcp", mcp: state }));
const ok = { ok: true, result: { text: "hi", isError: false, truncated: false } };
const call = (user: string, extra: Partial<{ tool: string }> = {}) => mcp.call(user, { server: "files", tool: extra.tool ?? "read.file", args: { path: "a" } }, { timeoutMs: 300 });

describe("connecting", () => {
  test("a bad token is refused, a good one is ready and online", async () => {
    const bad = await connect("nope");
    assert.deepEqual(await bad.first(), { type: "error", code: "unauthorized" });
    assert.equal(await bad.closed, 4401);
    const c = await connect("ana-token");
    assert.deepEqual(await c.first(), { type: "ready" });
    assert.equal(mcp.isOnline(ANA), true);
    c.ws.close();
    await c.closed;
    await until(() => !mcp.isOnline(ANA));
  });
  test("junk before hello closes the socket; browsers and other paths are refused", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${MCP_PATH}`);
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "req", req: { id: "x" } }));
    assert.equal(await closed, 1008);
    await assert.rejects(connect("ana-token", { origin: "https://evil.example" }), /403/);
    await assert.rejects(connect("ana-token", undefined, "/other"), /403/); // the folder relay still refuses what neither serves
  });
  test("the folder relay's own path is untouched by the skip", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/folder-host`);
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", token: "x", projectId: "33333333-3333-4333-8333-333333333333" }));
    assert.equal(await closed, 4401);
  });
  test("a second app for the same person takes over; nobody else's socket is touched", async () => {
    const a1 = await connect("ana-token");
    await a1.first();
    const b = await connect("ben-token");
    await b.first();
    const a2 = await connect("ana-token");
    await a2.first();
    assert.equal(await a1.closed, 4000);
    assert.equal(mcp.isOnline(ANA), true);
    assert.equal(mcp.isOnline(BEN), true);
    a2.ws.close();
    b.ws.close();
    await Promise.all([a2.closed, b.closed]);
  });
});

describe("tools and calls", () => {
  test("nothing is offered until the person's app says so; the list is per person", async () => {
    const a = await connect("ana-token");
    await a.first();
    const b = await connect("ben-token");
    await b.first();
    assert.deepEqual(mcp.tools(ANA), { servers: [] });
    send(a, { servers: [{ name: "files", tools: [tool("read.file", { description: "line one\nline two" })] }] });
    await until(() => mcp.tools(ANA).servers.length === 1);
    assert.equal(mcp.tools(ANA).servers[0]!.tools[0]!.description, "line one line two");
    assert.deepEqual(mcp.tools(BEN), { servers: [] }); // Ana's tools are not Ben's
    assert.deepEqual(mcp.tools("someone-else"), { servers: [] });
    a.ws.close();
    b.ws.close();
    await Promise.all([a.closed, b.closed]);
    await until(() => !mcp.isOnline(ANA));
    assert.deepEqual(mcp.tools(ANA), { servers: [] }); // the app is gone
  });

  test("a list that breaks the rules means no tools at all", async () => {
    const c = await connect("ana-token");
    await c.first();
    const good = { servers: [{ name: "files", tools: [tool("a")] }] };
    const bad = [
      { servers: [{ name: "bad name", tools: [tool("a")] }] },
      { servers: [{ name: "files", tools: [tool("bad tool!")] }] },
      { servers: [{ name: "files", tools: [tool("a", { inputSchema: { type: "object", properties: { x: { description: "z".repeat(9000) } } } })] }] },
      { servers: [{ name: "files", tools: [tool("a")] }, { name: "files", tools: [tool("b")] }] },
      { servers: [{ name: "files", tools: Array.from({ length: 51 }, (_, i) => tool(`t${i}`)) }] },
      { servers: [{ name: "a", tools: Array.from({ length: 30 }, (_, i) => tool(`t${i}`)) }, { name: "b", tools: Array.from({ length: 30 }, (_, i) => tool(`t${i}`)) }] },
      { servers: Array.from({ length: 11 }, (_, i) => ({ name: `s${i}`, tools: [] })) },
      { servers: [{ name: "files", tools: [tool("a", { inputSchema: "nope" })] }] },
      { servers: "all" },
    ];
    for (const b of bad) {
      send(c, good);
      await until(() => mcp.tools(ANA).servers.length === 1);
      send(c, b);
      await until(() => mcp.tools(ANA).servers.length === 0);
    }
    c.ws.close();
    await c.closed;
  });

  test("a call goes to the right person's app only, with its names and arguments; the answer is checked", async () => {
    const a = await connect("ana-token");
    await a.first();
    const b = await connect("ben-token");
    await b.first();
    const seenA: Record<string, unknown>[] = [];
    const seenB: Record<string, unknown>[] = [];
    answerWith(a.ws, (req) => (seenA.push(req), ok));
    answerWith(b.ws, (req) => (seenB.push(req), ok));
    assert.deepEqual(await call(ANA), { text: "hi", isError: false, truncated: false });
    assert.equal(seenB.length, 0);
    assert.deepEqual({ ...seenA[0], id: undefined }, { id: undefined, op: "mcp_call", server: "files", tool: "read.file", args: { path: "a" } });
    a.ws.close();
    b.ws.close();
    await Promise.all([a.closed, b.closed]);
    await assert.rejects(call(ANA), (e: unknown) => e instanceof RelayError && e.kind === "offline");
  });

  test("answers that break the rules are not passed on", async () => {
    const c = await connect("ana-token");
    await c.first();
    for (const bad of [{ ok: true, result: { text: "x".repeat(51_000), isError: false, truncated: false } }, { ok: true, result: { text: "ok" } }, { ok: true, result: "text" }, { ok: false, code: "weird", message: "x" }, { ok: false, code: "failed", message: "a\nb" }]) {
      const handler = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(String(raw)) as { type: string; req?: { id: string } };
        if (msg.type === "req") c.ws.send(JSON.stringify({ type: "res", res: { id: msg.req!.id, ...bad } }));
      };
      c.ws.on("message", handler);
      await assert.rejects(call(ANA), (e: unknown) => e instanceof RelayError && e.kind === "timeout"); // dropped, so the call times out
      c.ws.off("message", handler);
    }
    c.ws.close();
    await c.closed;
  });

  test("a tool the app refuses comes back with its code; a slow one is cancelled in the app", async () => {
    const c = await connect("ana-token");
    await c.first();
    const cancels: unknown[] = [];
    c.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; req?: { id: string; tool: string }; id?: string };
      if (msg.type === "cancel") cancels.push(msg.id);
      if (msg.type === "req" && msg.req!.tool === "gone") c.ws.send(JSON.stringify({ type: "res", res: { id: msg.req!.id, ok: false, code: "mcp_unavailable", message: "That tool is not available (the server is off or does not have it)." } }));
    });
    await assert.rejects(call(ANA, { tool: "gone" }), (e: unknown) => e instanceof RelayError && e.kind === "host" && e.code === "mcp_unavailable");
    await assert.rejects(call(ANA, { tool: "slow" }), (e: unknown) => e instanceof RelayError && e.kind === "timeout");
    await until(() => cancels.length === 1);
    const ctl = new AbortController();
    const p = mcp.call(ANA, { server: "files", tool: "slow", args: {} }, { signal: ctl.signal, timeoutMs: 5000 });
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(p, (e: unknown) => e instanceof RelayError && e.kind === "cancelled");
    await until(() => cancels.length === 2);
    c.ws.close();
    await c.closed;
  });

  test("too many calls in a short time are refused", async () => {
    const c = await connect("ben-token");
    await c.first();
    answerWith(c.ws, () => ({ ok: true, result: { text: "", isError: false, truncated: false } }));
    for (let i = 0; i < 120; i++) await mcp.call(BEN, { server: "s", tool: "t", args: {} });
    await assert.rejects(mcp.call(BEN, { server: "s", tool: "t", args: {} }), (e: unknown) => e instanceof RelayError && e.kind === "busy");
    c.ws.close();
    await c.closed;
  });

  test("a refreshed token for someone else is refused and closes the socket", async () => {
    const c = await connect("ana-token");
    await c.first();
    c.ws.send(JSON.stringify({ type: "token", token: "ben-token" }));
    assert.equal(await c.closed, 4401);
  });
});
