import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { McpConn, type McpLink } from "./mcp-conn.ts";

const tools = { servers: [{ name: "fake", tools: [{ name: "echo", description: "d", inputSchema: { type: "object" } }] }] };

describe("the person's connection for connected tools", () => {
  let wss: WebSocketServer;
  let port = 0;
  const sockets: ServerSocket[] = [];
  const seen: Record<string, unknown>[] = [];
  let onHello: (ws: ServerSocket) => void = (ws) => ws.send(JSON.stringify({ type: "ready" }));

  before(async () => {
    wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((r) => wss.once("listening", r));
    port = (wss.address() as { port: number }).port;
    wss.on("connection", (ws) => {
      sockets.push(ws);
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as Record<string, unknown>;
        seen.push(msg);
        if (msg.type === "hello") onHello(ws);
      });
    });
  });
  after(() => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  });

  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond(), "timed out");
  };
  const make = (extra: Partial<ConstructorParameters<typeof McpConn>[0]> = {}) => {
    const links: McpLink[] = [];
    const conn = new McpConn({ wsUrl: `ws://127.0.0.1:${port}`, getToken: () => "tok", getState: () => tools, call: async (req) => ({ id: (req as { id: string }).id, ok: true, result: { text: "hi", isError: false, truncated: false } }), onLink: (l) => links.push(l), ...extra });
    return { conn, links };
  };

  test("says hello with the token, reports the tool list when ready, answers calls", async () => {
    seen.length = 0;
    const { conn, links } = make();
    await until(() => conn.link === "connected");
    assert.deepEqual(seen[0], { type: "hello", token: "tok" });
    await until(() => seen.some((m) => m.type === "mcp"));
    assert.deepEqual(seen.find((m) => m.type === "mcp")?.mcp, tools);
    const ws = sockets.at(-1)!;
    ws.send(JSON.stringify({ type: "req", req: { id: "c1", op: "mcp_call", server: "fake", tool: "echo", args: {} } }));
    await until(() => seen.some((m) => m.type === "res"));
    assert.deepEqual((seen.find((m) => m.type === "res") as { res: unknown }).res, { id: "c1", ok: true, result: { text: "hi", isError: false, truncated: false } });
    ws.send(JSON.stringify({ type: "ping" }));
    await until(() => seen.some((m) => m.type === "pong"));
    conn.tokenChanged();
    await until(() => seen.some((m) => m.type === "token"));
    conn.close();
    assert.ok(links.includes("connected"));
  });

  test("a state change is sent again; nothing is sent before ready", async () => {
    seen.length = 0;
    let state = { servers: [] as typeof tools.servers };
    const { conn } = make({ getState: () => state });
    await until(() => conn.link === "connected");
    await until(() => seen.some((m) => m.type === "mcp"));
    state = tools;
    conn.stateChanged();
    await until(() => seen.filter((m) => m.type === "mcp").length === 2);
    assert.deepEqual(seen.filter((m) => m.type === "mcp").at(-1)?.mcp, tools);
    conn.close();
    conn.stateChanged(); // closed: nothing happens, no throw
  });

  test("a cancelled call sends nothing back; the fifth call at once is refused, not queued", async () => {
    seen.length = 0;
    const { conn } = make({
      call: (req, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ id: (req as { id: string }).id, ok: true, result: "late" }))),
    });
    await until(() => conn.link === "connected");
    const ws = sockets.at(-1)!;
    for (let i = 0; i < 5; i++) ws.send(JSON.stringify({ type: "req", req: { id: `h${i}`, op: "mcp_call", server: "fake", tool: "echo", args: {} } }));
    await until(() => seen.some((m) => m.type === "res"));
    assert.deepEqual((seen.find((m) => m.type === "res") as { res: unknown }).res, { id: "h4", ok: false, code: "busy", message: "Several tool calls are already running. Try again in a moment." });
    ws.send(JSON.stringify({ type: "cancel", id: "h0" }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(seen.filter((m) => m.type === "res").length, 1); // the cancelled one did not answer
    conn.close();
  });

  test("a failing call is reported as a plain failure, junk frames are ignored", async () => {
    seen.length = 0;
    const { conn } = make({ call: async () => { throw new Error("internal secret path /Users/x"); } });
    await until(() => conn.link === "connected");
    const ws = sockets.at(-1)!;
    ws.send("not json");
    ws.send(JSON.stringify({ type: "req", req: "garbage" }));
    ws.send(JSON.stringify({ type: "req" }));
    ws.send(JSON.stringify({ type: "req", req: { id: "x".repeat(100) } }));
    ws.send(JSON.stringify({ type: "req", req: { id: "c9", op: "mcp_call" } }));
    await until(() => seen.some((m) => m.type === "res"));
    const res = (seen.find((m) => m.type === "res") as { res: Record<string, unknown> }).res;
    assert.deepEqual(res, { id: "c9", ok: false, code: "mcp_failed", message: "The tool server failed to run that tool." });
    assert.ok(!JSON.stringify(res).includes("/Users"));
    assert.equal(conn.link, "connected");
    conn.close();
  });

  test("an unauthorized answer waits for a fresh token instead of retrying in a loop", async () => {
    const before = sockets.length;
    onHello = (ws) => ws.send(JSON.stringify({ type: "error", code: "unauthorized" }));
    const { conn } = make();
    await until(() => conn.link === "auth");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(sockets.length, before + 1);
    onHello = (ws) => ws.send(JSON.stringify({ type: "ready" }));
    conn.tokenChanged();
    await until(() => conn.link === "connected");
    conn.close();
  });
});
