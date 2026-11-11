import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import type { ClaudeCodeEvent, ClaudeCodeRequest } from "@mc/shared";
import WebSocket from "ws";
import { ClaudeCodeError } from "./claude-code-error.ts";
import { createMcpRelay, MCP_PATH } from "./mcp-relay.ts";

const ANA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";
const relay = createMcpRelay({ authenticate: async (t) => (t === "ana" ? ANA : t === "ben" ? BEN : null) }, { tokenMaxMs: 10_000 });
let server: Server;
let port = 0;

before(async () => {
  server = createServer((_req, res) => res.end("ok"));
  relay.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  relay.close();
  server.close();
});

async function app(token: string, ready: boolean) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${MCP_PATH}`);
  const frames: Record<string, unknown>[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "hello", token }));
  await until(() => frames.some((f) => f.type === "ready"));
  ws.send(JSON.stringify({ type: "mcp", claudeCode: { ready }, mcp: { servers: [] } }));
  const user = token === "ana" ? ANA : BEN;
  if (ready) await until(() => relay.claudeCodeReady(user));
  else await new Promise((r) => setTimeout(r, 30));
  return { ws, frames };
}
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), "timed out");
};
const req = (tools: string[] = ["read"]): ClaudeCodeRequest => ({ model: "sonnet", system: "s", prompt: "p", effort: null, tools: tools.map((name) => ({ name, description: "d", inputSchema: { type: "object" } })) });
const collect = async (gen: AsyncGenerator<ClaudeCodeEvent>) => {
  const out: ClaudeCodeEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};
const reqFrame = (frames: Record<string, unknown>[]) => frames.find((f) => f.type === "req")?.req as Record<string, unknown>;

describe("Claude Code login steps", () => {
  test("ready only while the person's own app says so", async () => {
    const a = await app("ana", false);
    assert.equal(relay.claudeCodeReady(ANA), false);
    a.ws.send(JSON.stringify({ type: "mcp", claudeCode: { ready: true }, mcp: { servers: [] } }));
    await until(() => relay.claudeCodeReady(ANA));
    assert.equal(relay.claudeCodeReady(BEN), false, "someone else is not ready");
    a.ws.send(JSON.stringify({ type: "mcp", mcp: { servers: [] } }));
    await until(() => !relay.claudeCodeReady(ANA));
    a.ws.close();
  });

  test("a step goes to the asker's own app only, and its events come back in order", async () => {
    const a = await app("ana", true);
    const b = await app("ben", true);
    const run = collect(relay.claudeCode(ANA, req()));
    await until(() => !!reqFrame(a.frames));
    const r = reqFrame(a.frames);
    assert.equal(r.op, "llm");
    assert.equal(r.model, "sonnet");
    assert.equal(reqFrame(b.frames), undefined, "ben's app never sees ana's step");
    const send = (event: unknown) => a.ws.send(JSON.stringify({ type: "llm", id: r.id, event }));
    send({ kind: "text", text: "Hel" });
    send({ kind: "text", text: "lo" });
    send({ kind: "call", id: "c1", name: "read", args: '{"path":"a"}' });
    send({ kind: "end", finish: "tool-calls", usage: { input: 5, output: 2 } });
    const events = await run;
    assert.deepEqual(events.map((e) => e.kind), ["text", "text", "call", "end"]);
    a.ws.close();
    b.ws.close();
  });

  test("refused when the app is offline, not switched on, or too busy", async () => {
    await assert.rejects(collect(relay.claudeCode(ANA, req())), (e) => e instanceof ClaudeCodeError && e.code === "cc_unavailable");
    const off = await app("ana", false);
    await assert.rejects(collect(relay.claudeCode(ANA, req())), (e) => e instanceof ClaudeCodeError && e.code === "cc_unavailable");
    off.ws.close();
  });

  test("a call to a tool the step did not offer fails the step", async () => {
    const a = await app("ana", true);
    const run = collect(relay.claudeCode(ANA, req(["read"])));
    await until(() => !!reqFrame(a.frames));
    a.ws.send(JSON.stringify({ type: "llm", id: reqFrame(a.frames).id, event: { kind: "call", id: "c", name: "rm_rf", args: "{}" } }));
    await assert.rejects(run, (e) => e instanceof ClaudeCodeError && e.code === "cc_failed");
    a.ws.close();
  });

  test("another person's frames and unknown ids are ignored", async () => {
    const a = await app("ana", true);
    const b = await app("ben", true);
    const run = collect(relay.claudeCode(ANA, req()));
    await until(() => !!reqFrame(a.frames));
    const id = reqFrame(a.frames).id;
    b.ws.send(JSON.stringify({ type: "llm", id, event: { kind: "text", text: "from ben" } })); // ben's socket cannot answer ana's step
    a.ws.send(JSON.stringify({ type: "llm", id: "nope", event: { kind: "text", text: "x" } }));
    a.ws.send(JSON.stringify({ type: "llm", id, event: { kind: "text", text: "from ana" } }));
    a.ws.send(JSON.stringify({ type: "llm", id, event: { kind: "end", finish: "stop" } }));
    const events = await run;
    assert.deepEqual(events.filter((e) => e.kind === "text"), [{ kind: "text", text: "from ana" }]);
    a.ws.close();
    b.ws.close();
  });

  test("the app's own error is passed on with its code; malformed frames are dropped", async () => {
    const a = await app("ana", true);
    const run = collect(relay.claudeCode(ANA, req()));
    await until(() => !!reqFrame(a.frames));
    const id = reqFrame(a.frames).id;
    a.ws.send(JSON.stringify({ type: "llm", id, event: { kind: "text", text: 5 } })); // not valid: dropped
    a.ws.send(JSON.stringify({ type: "llm_err", id, code: "cc_not_signed_in", message: "Claude Code is not signed in." }));
    await assert.rejects(run, (e) => e instanceof ClaudeCodeError && e.code === "cc_not_signed_in");
    a.ws.close();
  });

  test("aborting withdraws the step from the app", async () => {
    const a = await app("ana", true);
    const controller = new AbortController();
    const run = collect(relay.claudeCode(ANA, req(), controller.signal));
    await until(() => !!reqFrame(a.frames));
    controller.abort();
    await assert.rejects(run, ClaudeCodeError);
    await until(() => a.frames.some((f) => f.type === "cancel" && f.id === reqFrame(a.frames).id));
    a.ws.close();
  });

  test("the app disconnecting ends a running step", async () => {
    const a = await app("ana", true);
    const run = collect(relay.claudeCode(ANA, req()));
    await until(() => !!reqFrame(a.frames));
    a.ws.close();
    await assert.rejects(run, (e) => e instanceof ClaudeCodeError && e.code === "cc_unavailable");
  });
});
