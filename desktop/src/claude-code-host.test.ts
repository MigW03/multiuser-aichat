import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClaudeCodeEvent } from "@mc/shared";
import { ClaudeCodeHost, parseClaudeCodeConfig, validate, type ClaudeCodeConfig } from "./claude-code-host.ts";
import type { QueryFn } from "./claude-code-run.ts";

const ANA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";
const isId = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/.test(v);

function make(opts: { found?: string | null; login?: "signed_in" | "signed_out" | "unknown"; query?: QueryFn; saved?: ClaudeCodeConfig } = {}) {
  const saved: ClaudeCodeConfig[] = [];
  let changes = 0;
  const host = new ClaudeCodeHost({
    store: { load: async () => opts.saved ?? {}, save: async (c) => void saved.push(structuredClone(c)) },
    workDir: async () => "/tmp/work",
    query: async () => opts.query ?? (() => ({ async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", is_error: false, result: "hi", usage: { input_tokens: 1, output_tokens: 1 } }; } })),
    makeTools: () => ({}),
    find: async () => (opts.found === undefined ? "/usr/local/bin/claude" : opts.found),
    login: async () => ({ login: opts.login ?? "signed_in", account: "me@example.com · max" }),
    onChange: () => void changes++,
  });
  return { host, saved, changes: () => changes };
}
const body = { model: "sonnet", system: "s", prompt: "p", effort: null, tools: [] };

describe("off by default", () => {
  test("nothing is ready, even with claude installed and signed in, until the person switches it on", async () => {
    const { host } = make();
    await host.setUser(ANA);
    assert.equal(host.report().ready, false);
    await assert.rejects(host.run(body, new AbortController().signal, () => undefined), { code: "cc_unavailable" });
    assert.equal((await host.status()).enabled, false);
  });
  test("a saved file that says nothing about the person means off; junk is dropped", () => {
    assert.deepEqual(parseClaudeCodeConfig("not json", isId), {});
    assert.deepEqual(parseClaudeCodeConfig(JSON.stringify({ [ANA]: { enabled: "yes" }, nope: { enabled: true }, [BEN]: { enabled: true, binary: "/x/claude" } }), isId), { [ANA]: { enabled: false }, [BEN]: { enabled: true, binary: "/x/claude" } });
  });
});

describe("switching on", () => {
  test("ready needs on + found + not signed out; it follows the signed-in person only", async () => {
    const { host } = make({ saved: { [ANA]: { enabled: true } } });
    await host.setUser(ANA);
    assert.equal(host.report().ready, true);
    await host.setUser(BEN);
    assert.equal(host.report().ready, false, "ana's switch does not count for ben");
    await host.setUser(null);
    assert.equal(host.report().ready, false);
  });
  test("signed out or not found is not ready; unknown login still tries", async () => {
    const out = make({ saved: { [ANA]: { enabled: true } }, login: "signed_out" });
    await out.host.setUser(ANA);
    assert.equal(out.host.report().ready, false);
    assert.equal((await out.host.status()).error, "Claude Code is not signed in.");
    const none = make({ saved: { [ANA]: { enabled: true } }, found: null });
    await none.host.setUser(ANA);
    assert.equal(none.host.report().ready, false);
    const unknown = make({ saved: { [ANA]: { enabled: true } }, login: "unknown" });
    await unknown.host.setUser(ANA);
    assert.equal(unknown.host.report().ready, true);
  });
  test("setEnabled saves, checks claude, and switching off clears readiness at once", async () => {
    const { host, saved } = make();
    await host.setUser(ANA);
    await host.setEnabled(ANA, true);
    assert.equal(host.report().ready, true);
    assert.deepEqual(saved.at(-1), { [ANA]: { enabled: true } });
    await host.setEnabled(ANA, false);
    assert.equal(host.report().ready, false);
  });
  test("a failed save leaves it off", async () => {
    const host = new ClaudeCodeHost({ store: { load: async () => ({}), save: async () => Promise.reject(new Error("disk")) }, workDir: async () => "/tmp", query: async () => (() => ({}) as never), makeTools: () => ({}), find: async () => "/c", login: async () => ({ login: "signed_in", account: null }), onChange: () => undefined });
    await host.setUser(ANA);
    await assert.rejects(host.setEnabled(ANA, true));
    assert.equal(host.report().ready, false);
  });
  test("the status never carries more than the account line", async () => {
    const { host } = make({ saved: { [ANA]: { enabled: true } } });
    await host.setUser(ANA);
    const s = await host.status();
    assert.deepEqual(Object.keys(s).sort(), ["account", "binary", "custom", "enabled", "error", "link", "login"]);
  });
});

describe("running a step", () => {
  test("runs with the bundled options and sends events", async () => {
    const seen: Record<string, unknown>[] = [];
    const q: QueryFn = ({ options }) => {
      seen.push(options);
      return { async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", is_error: false, result: "Hello", usage: { input_tokens: 1, output_tokens: 2 } }; } };
    };
    const { host } = make({ saved: { [ANA]: { enabled: true } }, query: q });
    await host.setUser(ANA);
    const events: ClaudeCodeEvent[] = [];
    await host.run(body, new AbortController().signal, (e) => events.push(e));
    assert.deepEqual(events.map((e) => e.kind), ["text", "end"]);
    const env = seen[0]!.env as Record<string, string>;
    assert.equal(Object.keys(env).some((k) => k.startsWith("ANTHROPIC_")), false);
  });
  test("a step is refused while it is switched off, even if the server asks", async () => {
    const { host } = make();
    await host.setUser(ANA);
    await assert.rejects(host.run(body, new AbortController().signal, () => undefined), { code: "cc_unavailable" });
  });
});

describe("the server's request is checked again", () => {
  test("good request passes; unknown model, huge prompt, bad tools do not", () => {
    assert.equal(validate(body).model, "sonnet");
    assert.throws(() => validate({ ...body, model: "claude-opus-evil" }), { code: "bad_request" });
    assert.throws(() => validate({ ...body, prompt: "x".repeat(2_000_000) }), { code: "bad_request" });
    assert.throws(() => validate({ ...body, prompt: "  " }), { code: "bad_request" });
    assert.throws(() => validate({ ...body, tools: [{ name: "a", description: "d", inputSchema: "no" }] }), { code: "bad_request" });
    assert.throws(() => validate({ ...body, tools: Array.from({ length: 500 }, () => ({ name: "a", description: "", inputSchema: {} })) }), { code: "bad_request" });
    assert.throws(() => validate(null), { code: "bad_request" });
    assert.equal(validate({ ...body, effort: "bogus" }).effort, null);
  });
});
