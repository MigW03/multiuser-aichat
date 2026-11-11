import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClaudeCodeEvent, ClaudeCodeRequest } from "@mc/shared";
import { describeSpawnFailure, runStep, StepError, StepReader, toolNames, type QueryFn } from "./claude-code-run.ts";

const ev = (event: unknown) => ({ type: "stream_event", event });
const start = ev({ type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 3 } } });
const text = (i: number, t: string) => [ev({ type: "content_block_start", index: i, content_block: { type: "text" } }), ev({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: t } }), ev({ type: "content_block_stop", index: i })];
const tool = (i: number, id: string, name: string, json: string) => [
  ev({ type: "content_block_start", index: i, content_block: { type: "tool_use", id, name } }),
  ev({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(0, 3) } }),
  ev({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(3) } }),
  ev({ type: "content_block_stop", index: i }),
];
const stop = ev({ type: "message_stop" });
const delta = (out: number, reason = "end_turn") => ev({ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: out } });
const result = (extra: Record<string, unknown> = {}) => ({ type: "result", subtype: "success", is_error: false, result: "", usage: { input_tokens: 12, output_tokens: 7 }, ...extra });

const req = (over: Partial<ClaudeCodeRequest> = {}): ClaudeCodeRequest => ({ model: "sonnet", system: "sys", prompt: "hi", effort: null, tools: [{ name: "read.file", description: "Read", inputSchema: { type: "object" } }], ...over });

function fakeQuery(messages: unknown[], seen: { options?: Record<string, unknown>; prompt?: unknown; closed?: boolean } = {}): QueryFn {
  return ({ prompt, options }) => {
    seen.prompt = prompt;
    seen.options = options;
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of messages) yield m;
      },
      close: () => void (seen.closed = true),
    };
  };
}
const deps = (query: QueryFn) => ({ query, makeTools: () => ({ fake: true }), bin: "/usr/local/bin/claude", cwd: "/tmp/work", env: { PATH: "/usr/bin" } });
async function run(messages: unknown[], r: ClaudeCodeRequest = req(), seen: Parameters<typeof fakeQuery>[1] = {}) {
  const events: ClaudeCodeEvent[] = [];
  await runStep(r, deps(fakeQuery(messages, seen)), (e) => events.push(e), new AbortController().signal);
  return events;
}

describe("tool names", () => {
  test("names claude cannot take are made safe, kept unique, and mapped back", () => {
    const { exposed, list } = toolNames([{ name: "a.b", description: "", inputSchema: {} }, { name: "a_b", description: "", inputSchema: {} }]);
    assert.deepEqual(list.map((t) => t.name), ["a_b", "a_b_2"]);
    assert.equal(exposed.get("a_b"), "a.b");
    assert.equal(exposed.get("a_b_2"), "a_b");
  });
});

describe("one AI step", () => {
  test("plain text streams through and ends with usage", async () => {
    const events = await run([start, ...text(0, "Hel"), ...text(1, "lo"), delta(7), stop, result()]);
    assert.deepEqual(events, [{ kind: "text", text: "Hel" }, { kind: "text", text: "lo" }, { kind: "end", finish: "stop", usage: { input: 15, output: 7 } }]);
  });

  test("a tool call is handed back by its own name and claude is stopped before anything runs", async () => {
    const seen: { closed?: boolean } = {};
    const events = await run([start, ...text(0, "Looking."), ...tool(1, "toolu_1", "mcp__nido__read_file", '{"path":"a.txt"}'), delta(5, "tool_use"), stop, result({ result: "never reached" })], req(), seen);
    assert.deepEqual(events.map((e) => e.kind), ["text", "call", "end"]);
    const call = events[1] as Extract<ClaudeCodeEvent, { kind: "call" }>;
    assert.equal(call.name, "read.file", "mapped back to the server's own name");
    assert.equal(call.args, '{"path":"a.txt"}');
    assert.equal((events[2] as Extract<ClaudeCodeEvent, { kind: "end" }>).finish, "tool-calls");
    assert.equal(seen.closed, true, "claude is closed");
  });

  test("several calls in one turn all come back", async () => {
    const events = await run([start, ...tool(0, "a", "mcp__nido__read_file", "{}"), ...tool(1, "b", "mcp__nido__read_file", '{"x":1}'), delta(1, "tool_use"), stop]);
    assert.deepEqual(events.map((e) => e.kind), ["call", "call", "end"]);
  });

  test("a tool the step did not offer, or one of claude's own, is never called", async () => {
    const events = await run([start, ...tool(0, "a", "Bash", '{"command":"rm -rf /"}'), ...tool(1, "b", "mcp__other__x", "{}"), ...tool(2, "c", "mcp__nido__nope", "{}"), delta(1, "tool_use"), stop, result()]);
    assert.deepEqual(events.map((e) => e.kind), ["end"]);
    assert.equal((events[0] as Extract<ClaudeCodeEvent, { kind: "end" }>).finish, "stop");
  });

  test("broken or non-object arguments become an empty object", async () => {
    const events = await run([start, ...tool(0, "a", "mcp__nido__read_file", "{oops"), ...tool(1, "b", "mcp__nido__read_file", "[1,2]"), stop]);
    assert.deepEqual(events.filter((e) => e.kind === "call").map((e) => (e as { args: string }).args), ["{}", "{}"]);
  });

  test("thinking is not forwarded", async () => {
    const events = await run([start, ev({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }), ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "secret plan" } }), ...text(1, "Hi"), stop, result()]);
    assert.deepEqual(events.map((e) => e.kind), ["text", "end"]);
  });

  test("without stream events the whole message is used", async () => {
    const events = await run([{ type: "assistant", message: { content: [{ type: "text", text: "All at once" }] } }, result()]);
    assert.deepEqual(events.slice(0, 1), [{ kind: "text", text: "All at once" }]);
  });

  test("max_tokens is reported as length", async () => {
    const events = await run([start, ...text(0, "x"), delta(9, "max_tokens"), stop, result({ stop_reason: "max_tokens" })]);
    assert.equal((events.at(-1) as Extract<ClaudeCodeEvent, { kind: "end" }>).finish, "length");
  });
});

describe("failures", () => {
  test("not signed in is said plainly, and the error's own text is not an answer", async () => {
    const msgs = [{ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Invalid API key · Please run /login" }] } }, result({ is_error: true, subtype: "success" })];
    await assert.rejects(run(msgs), (e) => e instanceof StepError && e.code === "cc_not_signed_in" && !/Invalid API key/.test(e.message));
  });
  test("usage limits map to cc_limit", async () => {
    await assert.rejects(run([{ type: "assistant", error: "rate_limit", message: { content: [] } }, result({ is_error: true })]), (e) => e instanceof StepError && e.code === "cc_limit");
  });
  test("a run that ends without an answer is a failure, not an empty answer", async () => {
    await assert.rejects(run([start]), (e) => e instanceof StepError && e.code === "cc_failed");
  });
  test("a missing program, and a sign-in message on stderr, are told apart", () => {
    assert.equal(describeSpawnFailure(Object.assign(new Error("x"), { code: "ENOENT" }), "").code, "cc_not_found");
    assert.equal(describeSpawnFailure(new Error("exit 1"), "Not logged in · Please run /login").code, "cc_not_signed_in");
    assert.equal(describeSpawnFailure(new Error("exit 1"), "boom").code, "cc_failed");
  });
  test("a thrown spawn error is mapped; stderr text never reaches the message", async () => {
    const q: QueryFn = ({ options }) => ({
      async *[Symbol.asyncIterator]() {
        (options.stderr as (d: string) => void)("secret token sk-ant-oat01-abcdef");
        throw new Error("Claude Code process exited with code 1");
      },
    });
    await assert.rejects(runStep(req(), deps(q), () => undefined, new AbortController().signal), (e) => e instanceof StepError && e.code === "cc_failed" && !/sk-ant/.test(e.message));
  });
  test("aborting stops the run", async () => {
    const controller = new AbortController();
    const q: QueryFn = () => ({
      async *[Symbol.asyncIterator]() {
        yield start;
        controller.abort();
        yield* text(0, "late");
      },
    });
    await assert.rejects(runStep(req(), deps(q), () => undefined, controller.signal), (e) => e instanceof StepError && e.message === "Cancelled.");
  });
  test("an answer over the limit is cut off with an error", async () => {
    const big = "x".repeat(300_000);
    await assert.rejects(run([start, ...text(0, big), ...text(1, big)]), (e) => e instanceof StepError && e.code === "cc_limit");
  });
});

describe("what claude is started with", () => {
  test("every built-in tool, the person's own settings, hooks, skills, plugins and memory are off; nothing is saved; one turn", async () => {
    const seen: { options?: Record<string, unknown>; prompt?: string } = {};
    await run([start, ...text(0, "ok"), stop, result()], req({ effort: "high" }), seen);
    const o = seen.options!;
    assert.deepEqual(o.tools, []);
    assert.deepEqual(o.settingSources, []);
    assert.deepEqual(o.skills, []);
    assert.deepEqual(o.plugins, []);
    assert.equal(o.persistSession, false);
    assert.equal(o.maxTurns, 1);
    assert.equal(o.strictMcpConfig, true);
    assert.equal(o.permissionMode, "dontAsk");
    assert.equal(o.pathToClaudeCodeExecutable, "/usr/local/bin/claude");
    assert.equal(o.systemPrompt, "sys");
    assert.equal(o.effort, "high");
    assert.deepEqual(o.settings, { autoMemoryEnabled: false });
    assert.deepEqual(o.env, { PATH: "/usr/bin" });
    assert.deepEqual(Object.keys(o.mcpServers as object), ["nido"]);
    assert.equal(o.allowedTools, undefined, "nothing is pre-approved");
    assert.equal(seen.prompt, "hi");
  });
  test("no tools: no tool server; thinking off is passed as disabled", async () => {
    const seen: { options?: Record<string, unknown> } = {};
    await run([start, ...text(0, "ok"), stop, result()], req({ tools: [], effort: "off" }), seen);
    assert.equal(seen.options!.mcpServers, undefined);
    assert.deepEqual(seen.options!.thinking, { type: "disabled" });
    assert.equal(seen.options!.effort, undefined);
  });
});
