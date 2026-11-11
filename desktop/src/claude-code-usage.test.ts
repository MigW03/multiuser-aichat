import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClaudeCodeEvent, ClaudeCodeRequest } from "@mc/shared";
import { ClaudeCodeHost } from "./claude-code-host.ts";
import { askPlanUsage, runStep, type QueryFn, type QueryLike } from "./claude-code-run.ts";
import { fractionToPercent, UsageTracker } from "./claude-code-usage.ts";

const ANA = "11111111-1111-4111-8111-111111111111";

describe("rate-limit events", () => {
  test("windows are kept by type, in a fixed order, with percent and reset time", () => {
    const t = new UsageTracker();
    assert.equal(t.snapshot(), null);
    assert.equal(t.applyEvent({ status: "allowed", rateLimitType: "seven_day", utilization: 0.4, resetsAt: 2000 }), true);
    t.applyEvent({ status: "allowed", rateLimitType: "five_hour", utilization: 0.125, resetsAt: 1000 });
    const s = t.snapshot()!;
    assert.deepEqual(s.windows.map((w) => [w.label, w.usedPercent, w.resetsAt]), [["5-hour", 12.5, 1000], ["Weekly", 40, 2000]]);
    assert.equal(s.source, "events");
    assert.equal(s.reached, false);
  });
  test("a later event updates one window and keeps what it did not say", () => {
    const t = new UsageTracker();
    t.applyEvent({ status: "allowed", rateLimitType: "five_hour", utilization: 0.5, resetsAt: 1000 });
    t.applyEvent({ status: "allowed", rateLimitType: "five_hour" });
    assert.deepEqual(t.snapshot()!.windows[0], { key: "five_hour", label: "5-hour", usedPercent: 50, resetsAt: 1000 });
  });
  test("warning and rejected show, and clear when claude says allowed again", () => {
    const t = new UsageTracker();
    t.applyEvent({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9 });
    assert.equal(t.snapshot()!.warning, true);
    t.applyEvent({ status: "rejected", rateLimitType: "five_hour" });
    assert.deepEqual([t.snapshot()!.reached, t.snapshot()!.warning], [true, false]);
    assert.equal(t.snapshot()!.windows.find((w) => w.key === "five_hour")!.usedPercent, 100);
    t.applyEvent({ status: "allowed", rateLimitType: "five_hour", utilization: 0.1 });
    assert.deepEqual([t.snapshot()!.reached, t.snapshot()!.warning], [false, true]);
  });
  test("junk is ignored and values are clamped", () => {
    const t = new UsageTracker();
    for (const junk of [null, 5, "x", {}, { status: "nope" }, { rateLimitType: "made_up" }]) assert.equal(t.applyEvent(junk), false);
    t.applyEvent({ status: "allowed", rateLimitType: "five_hour", utilization: 7 });
    assert.equal(t.snapshot()!.windows[0]!.usedPercent, 100);
    assert.equal(fractionToPercent(-1), 0);
    assert.equal(fractionToPercent(null), null);
  });
});

describe("the answer to asking directly (/usage)", () => {
  const answer = {
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 30, resets_at: "2026-11-11T22:00:00Z" },
      seven_day: { utilization: 100, resets_at: "2026-11-15T00:00:00Z" },
      model_scoped: [{ display_name: "Fable\u001b[31m", utilization: 12, resets_at: null }],
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25, currency: "usd" },
    },
  };
  test("percent is already 0-100; the reset time is parsed; extra usage is in major units; control characters are cleaned", () => {
    const t = new UsageTracker();
    t.applyEvent({ status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.5 });
    assert.equal(t.applyUsage(answer), true);
    const s = t.snapshot()!;
    assert.equal(s.source, "usage");
    assert.equal(s.plan, "max");
    assert.deepEqual(s.windows.map((w) => [w.label, w.usedPercent]), [["5-hour", 30], ["Weekly", 100], ["Weekly Fable[31m", 12]]);
    assert.equal(s.windows[0]!.resetsAt, Date.parse("2026-11-11T22:00:00Z") / 1000);
    assert.equal(s.reached, true, "a full window is a reached limit");
    assert.deepEqual(s.extra, { enabled: true, used: 12.5, limit: 50, currency: "USD" });
    assert.ok(!s.windows.some((w) => w.key === "seven_day_opus"), "the answer replaces what the events said");
  });
  test("not available (API key login) or junk changes nothing", () => {
    const t = new UsageTracker();
    assert.equal(t.applyUsage({ rate_limits_available: false, rate_limits: null }), false);
    assert.equal(t.applyUsage(null), false);
    assert.equal(t.snapshot(), null);
  });
});

const req = (): ClaudeCodeRequest => ({ model: "sonnet", system: "s", prompt: "p", effort: null, tools: [] });
const result = { type: "result", subtype: "success", is_error: false, result: "Hi", usage: { input_tokens: 1, output_tokens: 1 } };

describe("capturing events during an answer", () => {
  test("rate_limit_event messages reach the callback and are not treated as answer text", async () => {
    const seen: unknown[] = [];
    const events: ClaudeCodeEvent[] = [];
    const q: QueryFn = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.2 } };
        yield result;
      },
    });
    await runStep(req(), { query: q, makeTools: () => ({}), bin: "/c", cwd: "/tmp", env: {}, onRateLimit: (i) => seen.push(i) }, (e) => events.push(e), new AbortController().signal);
    assert.deepEqual(seen, [{ status: "allowed", rateLimitType: "five_hour", utilization: 0.2 }]);
    assert.deepEqual(events.map((e) => e.kind), ["text", "end"]);
  });
});

describe("asking claude for plan usage", () => {
  const fake = (usage?: () => Promise<unknown>, seen: { options?: Record<string, unknown>; closed?: boolean; prompt?: unknown } = {}): QueryFn => ({ prompt, options }) => {
    seen.options = options;
    seen.prompt = prompt;
    const q: QueryLike = { async *[Symbol.asyncIterator]() { /* nothing */ }, close: () => void (seen.closed = true), ...(usage ? { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage } : {}) };
    return q;
  };
  const deps = (query: QueryFn) => ({ query, bin: "/c", cwd: "/tmp", env: { PATH: "/usr/bin" } });

  test("returns the answer, with the same isolation as an answer, no user turn, and closes claude", async () => {
    const seen: { options?: Record<string, unknown>; closed?: boolean; prompt?: unknown } = {};
    assert.deepEqual(await askPlanUsage(deps(fake(async () => ({ ok: 1 }), seen)), new AbortController().signal), { ok: 1 });
    assert.deepEqual(seen.options!.tools, []);
    assert.deepEqual(seen.options!.settingSources, []);
    assert.equal(seen.options!.persistSession, false);
    assert.equal(seen.options!.permissionMode, "dontAsk");
    assert.equal(seen.options!.strictMcpConfig, true);
    assert.equal(typeof seen.prompt, "object", "an input that says nothing, not a question");
    assert.equal(seen.closed, true);
  });
  test("an SDK without the call, a failing call, or a slow one gives null", async () => {
    assert.equal(await askPlanUsage(deps(fake()), new AbortController().signal), null);
    assert.equal(await askPlanUsage(deps(fake(async () => Promise.reject(new Error("changed")))), new AbortController().signal), null);
    assert.equal(await askPlanUsage(deps(fake(() => new Promise(() => undefined))), new AbortController().signal, 30), null);
  });
});

describe("the host", () => {
  const make = (usage: QueryFn, enabled = true) => {
    let changes = 0;
    const host = new ClaudeCodeHost({
      store: { load: async (): Promise<Record<string, { enabled: boolean }>> => (enabled ? { [ANA]: { enabled: true } } : {}), save: async () => undefined },
      workDir: async () => "/tmp/w",
      query: async () => usage,
      makeTools: () => ({}),
      find: async () => "/c",
      login: async () => ({ login: "signed_in", account: null }),
      onChange: () => void changes++,
    });
    return { host, changes: () => changes };
  };
  const asker = (calls: { n: number }): QueryFn => () => ({
    async *[Symbol.asyncIterator]() { /* nothing */ },
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => (calls.n++, { rate_limits_available: true, subscription_type: "pro", rate_limits: { five_hour: { utilization: 10, resets_at: null } } }),
  });

  test("nothing is known while it is off; an answer's events fill it in; the person's refresh asks claude at most every 30 s", async () => {
    const calls = { n: 0 };
    const off = make(asker(calls), false);
    await off.host.setUser(ANA);
    assert.equal(await off.host.getUsage(true), null);
    assert.equal(calls.n, 0, "claude is not asked while switched off");

    const { host, changes } = make(asker(calls));
    await host.setUser(ANA);
    assert.equal(await host.getUsage(false), null, "nothing yet, and not asked");
    assert.equal(calls.n, 0);
    const u = await host.getUsage(true);
    assert.equal(u?.plan, "pro");
    assert.equal(u?.windows[0]?.usedPercent, 10);
    assert.equal(calls.n, 1);
    await host.getUsage(true);
    assert.equal(calls.n, 1, "asked again too soon: the last answer is shown");
    assert.ok(changes() > 0, "the page is told");
  });
  test("it is forgotten when the person signs out, so the next person never sees it", async () => {
    const calls = { n: 0 };
    const { host } = make(asker(calls));
    await host.setUser(ANA);
    await host.getUsage(true);
    await host.setUser(null);
    assert.equal(await host.getUsage(false), null);
    await host.setUser(ANA);
    assert.equal(await host.getUsage(false), null);
  });
});
