import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ClaudeCodeEvent, ClaudeCodeRequest } from "@mc/shared";
import { claudeCodeKeyFor, claudeCodeModel, claudeCodeUserOf, ClaudeCodeError, promptFor, registerClaudeCode } from "./claude-code.ts";

const USER = "11111111-1111-4111-8111-111111111111";

describe("the key of this provider only says whose app to ask", () => {
  test("round trip, and nothing else is accepted", () => {
    assert.equal(claudeCodeUserOf(claudeCodeKeyFor(USER)), USER);
    assert.equal(claudeCodeUserOf("sk-ant-api03-whatever"), null);
    assert.equal(claudeCodeUserOf("local:claudecode:"), null);
  });
});

describe("promptFor", () => {
  test("system text is separated; turns, tool calls and results are plain text; files are left out", () => {
    const { system, prompt } = promptFor([
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "Read a.txt" }, { type: "file", mediaType: "image/png", data: { type: "data", data: "AQ==" } as never }] },
      { role: "assistant", content: [{ type: "text", text: "Reading." }, { type: "tool-call", toolCallId: "1", toolName: "read", input: { path: "a.txt" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "read", output: { type: "text", value: "hello" } }] },
    ]);
    assert.equal(system, "Be brief.");
    assert.match(prompt, /\[user\]\nRead a\.txt/);
    assert.match(prompt, /image\/png file was attached; this connection cannot read files/);
    assert.match(prompt, /\[you called the tool read with \{"path":"a\.txt"\}\]/);
    assert.match(prompt, /\[result of the tool read\]\nhello/);
    assert.ok(prompt.trimEnd().endsWith("[assistant]"));
  });
  test("a very long history is cut at the start, not the end", () => {
    const long = "x".repeat(2_000_000);
    const { prompt } = promptFor([{ role: "user", content: [{ type: "text", text: `${long}END` }] }]);
    assert.ok(prompt.length < 1_600_000);
    assert.match(prompt, /END\n\n\[assistant\]\n$/);
  });
});

async function read(stream: ReadableStream<LanguageModelV4StreamPart>) {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

function runnerOf(events: ClaudeCodeEvent[] | Error, seen: { req?: ClaudeCodeRequest; user?: string } = {}) {
  registerClaudeCode({
    ready: () => true,
    async *run(user, req) {
      seen.user = user;
      seen.req = req;
      if (events instanceof Error) throw events;
      for (const e of events) yield e;
    },
  });
}
const call = { prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }] };

describe("the language model", () => {
  test("text and a tool call become stream parts, and the finish says tool-calls", async () => {
    const seen: { req?: ClaudeCodeRequest; user?: string } = {};
    runnerOf([{ kind: "text", text: "Let me look." }, { kind: "call", id: "c1", name: "read", args: '{"path":"a"}' }, { kind: "end", finish: "tool-calls", usage: { input: 10, output: 3 } }], seen);
    const model = claudeCodeModel(USER, "sonnet");
    const { stream } = await model.doStream({ ...call, reasoning: "high", tools: [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }] });
    const parts = await read(stream);
    assert.deepEqual(parts.map((p) => p.type), ["stream-start", "text-start", "text-delta", "text-end", "tool-call", "finish"]);
    const finish = parts.at(-1) as Extract<LanguageModelV4StreamPart, { type: "finish" }>;
    assert.equal(finish.finishReason.unified, "tool-calls");
    assert.equal(finish.usage.inputTokens.total, 10);
    assert.equal(seen.user, USER, "the step is asked for the key's own user");
    assert.equal(seen.req?.effort, "high");
    assert.equal(seen.req?.tools[0]?.name, "read");
  });

  test("an error from the app becomes an error part, never a thrown crash", async () => {
    runnerOf(new ClaudeCodeError("cc_not_signed_in", "Claude Code is not signed in."));
    const { stream } = await claudeCodeModel(USER, "sonnet").doStream(call);
    const parts = await read(stream);
    const err = parts.find((p) => p.type === "error") as { error: unknown };
    assert.ok(err.error instanceof ClaudeCodeError);
  });

  test("doGenerate gathers text and calls", async () => {
    runnerOf([{ kind: "text", text: "A" }, { kind: "text", text: "B" }, { kind: "end", finish: "stop" }]);
    const r = await claudeCodeModel(USER, "sonnet").doGenerate(call);
    assert.deepEqual(r.content, [{ type: "text", text: "AB" }]);
    assert.equal(r.finishReason.unified, "stop");
  });

  test("an oversized tool schema is replaced, not forwarded", async () => {
    const seen: { req?: ClaudeCodeRequest } = {};
    runnerOf([{ kind: "end", finish: "stop" }], seen);
    const huge = { type: "object", properties: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`p${i}`, { type: "string", description: "x".repeat(20) }])) };
    await read((await claudeCodeModel(USER, "sonnet").doStream({ ...call, tools: [{ type: "function", name: "big", inputSchema: huge as never }] })).stream);
    assert.deepEqual(seen.req?.tools[0]?.inputSchema, { type: "object", additionalProperties: true });
  });
});
