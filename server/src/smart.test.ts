import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SMART_MODEL_ID, type ModelInfo } from "@mc/shared";
import { pickSmartModel } from "./smart-pick.ts";
import { cheapest, cleanSmartSet, creditStatus, decisionRequest, describeOption, extractChoice, JEV_MODEL, QUESTION_ID, smartOptions, SMART_INSTRUCTIONS } from "./smart-rules.ts";

const usage = (budget: { remaining: number | null } | null, credits: { total: number; used: number } | null) => ({
  budget: budget && { limit: 10, spent: 0, remaining: budget.remaining, resetInterval: null, resetsAt: null },
  credits,
});

const info: ModelInfo[] = [
  { id: "openai/gpt-oss-20b", name: "OpenAI: gpt-oss-20b", pricing: { input: 0.02, output: 0.09 }, vision: false },
  { id: "google/gemini-2.5-flash-lite", name: "Google: Gemini 2.5 Flash Lite", pricing: { input: 0.1, output: 0.4 }, vision: true },
  { id: "anthropic/claude-opus-4.1", name: "Anthropic: Claude Opus 4.1", pricing: { input: 15, output: 75 }, vision: true },
];
const SET = ["google/gemini-2.5-flash-lite", "openai/gpt-oss-20b"];
const input = { latest: "Explain how a B-tree index speeds up lookups.", context: [], pictures: false };

describe("cleanSmartSet", () => {
  it("keeps valid ids once each, in order", () => {
    assert.deepEqual(cleanSmartSet(["openai/gpt-5-mini", "anthropic/claude-sonnet-4.5", "openai/gpt-5-mini"]), ["openai/gpt-5-mini", "anthropic/claude-sonnet-4.5"]);
  });
  it("accepts an empty set (a way to clear it)", () => assert.deepEqual(cleanSmartSet([]), []));
  it("rejects what is not a list of model ids", () => {
    assert.equal(cleanSmartSet("openai/gpt-5"), null);
    assert.equal(cleanSmartSet([1]), null);
    assert.equal(cleanSmartSet(["has space"]), null);
    assert.equal(cleanSmartSet([""]), null);
    assert.equal(cleanSmartSet(["a".repeat(201)]), null);
  });
  it("rejects the Auto marker and lists that are too long", () => {
    assert.equal(cleanSmartSet(["a/b", SMART_MODEL_ID]), null);
    assert.equal(cleanSmartSet(Array.from({ length: 13 }, (_, i) => `a/m${i}`)), null);
  });
});

describe("creditStatus", () => {
  it("is no_credits when the key's cap is used up", () => assert.equal(creditStatus(usage({ remaining: 0 }, null)), "no_credits"));
  it("is no_credits when the readable account balance is zero", () => assert.equal(creditStatus(usage(null, { total: 5, used: 5 })), "no_credits"));
  it("is ok when something is left", () => {
    assert.equal(creditStatus(usage({ remaining: 1.5 }, null)), "ok");
    assert.equal(creditStatus(usage(null, { total: 5, used: 4 })), "ok");
  });
  it("is ok when OpenRouter does not say (a key with no cap and no readable balance)", () => {
    assert.equal(creditStatus(usage(null, null)), "ok");
    assert.equal(creditStatus(usage({ remaining: null }, null)), "ok");
  });
});

describe("smartOptions and cheapest", () => {
  it("offers exactly the set, in the person's order, under short keys", () => {
    const o = smartOptions(SET, info, false);
    assert.deepEqual(o.map((x) => [x.key, x.id]), [["m1", "google/gemini-2.5-flash-lite"], ["m2", "openai/gpt-oss-20b"]]);
  });
  it("never adds a model that is not in the set", () => assert.ok(smartOptions(SET, info, false).every((o) => SET.includes(o.id))));
  it("leaves out models that cannot see pictures when the message has pictures", () => {
    assert.deepEqual(smartOptions(SET, info, true).map((o) => o.id), ["google/gemini-2.5-flash-lite"]);
  });
  it("keeps all models when none can see pictures", () => {
    assert.equal(smartOptions(["openai/gpt-oss-20b"], info, true).length, 1);
  });
  it("picks the cheapest by price, treating an unknown price as the dearest", () => {
    assert.equal(cheapest(smartOptions(SET, info, false)).id, "openai/gpt-oss-20b");
    assert.equal(cheapest(smartOptions(["x/unknown", "openai/gpt-oss-20b"], info, false)).id, "openai/gpt-oss-20b");
    assert.equal(cheapest(smartOptions(["x/a", "x/b"], [], false)).id, "x/a");
  });
});

describe("decisionRequest", () => {
  const body = decisionRequest(smartOptions(SET, info, false), { latest: "x".repeat(9000), context: Array.from({ length: 9 }, (_, i) => ({ from: "person" as const, text: `m${i}` })), pictures: true });
  it("asks Jev one choice question whose options are the set", () => {
    assert.equal(body.model, JEV_MODEL);
    const q = body.questions[QUESTION_ID];
    assert.equal(q.type, "choice");
    assert.equal(q.instructions, SMART_INSTRUCTIONS);
    assert.deepEqual(Object.keys(q.criteria), ["m1", "m2"]);
  });
  it("describes each option with price, rank and picture support", () => {
    const o = smartOptions(SET, info, false);
    assert.equal(describeOption(o[1]!, o), "OpenAI: gpt-oss-20b (openai/gpt-oss-20b). $0.02 input and $0.09 output per million tokens; the cheapest option. Cannot look at pictures.");
    assert.match(describeOption(o[0]!, o), /the most expensive option\. Can look at pictures\.$/);
  });
  it("cuts the latest message and keeps only the last 6 context messages", () => {
    assert.equal(body.state.latest_message.length, 4000);
    assert.deepEqual(body.state.recent_messages.map((m) => m.text), ["m3", "m4", "m5", "m6", "m7", "m8"]);
    assert.equal(body.state.latest_message_has_pictures, true);
  });
});

describe("extractChoice", () => {
  const o = smartOptions(SET, info, false);
  it("reads an answer keyed by the question id", () => {
    assert.equal(extractChoice({ pick: { type: "choice", choice: "m2" } }, o)?.id, "openai/gpt-oss-20b");
    assert.equal(extractChoice({ answers: { pick: { choice: "M1 " } } }, o)?.id, "google/gemini-2.5-flash-lite");
    assert.equal(extractChoice({ pick: "m1" }, o)?.id, "google/gemini-2.5-flash-lite");
  });
  it("gives null for anything that is not one of the options", () => {
    assert.equal(extractChoice({ pick: { choice: "m3" } }, o), null);
    assert.equal(extractChoice({ pick: { choice: "openai/gpt-6-luna" } }, o), null);
    assert.equal(extractChoice({ pick: { choice: "openai/gpt-oss-20b" } }, o), null);
    assert.equal(extractChoice({ other: { choice: "m1" } }, o), null);
    assert.equal(extractChoice(null, o), null);
    assert.equal(extractChoice("m1", o), null);
  });
});

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

/** The choice without its timing. */
const pick = async (a: Parameters<typeof pickSmartModel>[0]) => {
  const { ms, ...rest } = await pickSmartModel(a);
  assert.equal(typeof ms, "number");
  return rest;
};

describe("pickSmartModel", () => {
  const args = { apiKey: "sk-test", models: SET, info, ...input };
  it("returns the model Jev chose, and sends the key only to the decisions endpoint", async () => {
    let seen: { url: string; auth: string | null; body: string } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get("authorization"), body: String(init.body) };
      return new Response(JSON.stringify({ pick: { choice: "m1" } }));
    }) as unknown as typeof fetch;
    const r = await pick({ ...args, fetchImpl });
    assert.deepEqual(r, { model: "google/gemini-2.5-flash-lite", fallback: false });
    assert.equal(seen!.url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(seen!.auth, "Bearer sk-test");
    assert.ok(!seen!.body.includes("sk-test"));
  });
  it("skips the classifier for a very short message", async () => {
    const fetchImpl = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    assert.deepEqual(await pick({ ...args, latest: "hi", fetchImpl }), { model: "openai/gpt-oss-20b", fallback: false });
    // a picture always gets the classifier, even with a short caption
    assert.equal((await pick({ ...args, models: ["google/gemini-2.5-flash-lite", "anthropic/claude-opus-4.1"], latest: "hi", pictures: true, fetchImpl })).fallback, true);
  });
  it("falls back to the cheapest model of the set when OpenRouter refuses", async () => {
    for (const status of [400, 401, 402, 429, 500]) assert.deepEqual(await pick({ ...args, fetchImpl: reply(status, {}) }), { model: "openai/gpt-oss-20b", fallback: true, why: `HTTP ${status}` });
  });
  it("falls back when the answer is unreadable or names a model outside the set", async () => {
    assert.deepEqual(await pick({ ...args, fetchImpl: reply(200, { pick: { choice: "openai/gpt-6-luna" } }) }), { model: "openai/gpt-oss-20b", fallback: true, why: "unreadable answer" });
    assert.deepEqual(await pick({ ...args, fetchImpl: reply(200, "nope") }), { model: "openai/gpt-oss-20b", fallback: true, why: "unreadable answer" });
  });
  it("falls back when the request itself fails", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    assert.deepEqual(await pick({ ...args, fetchImpl }), { model: "openai/gpt-oss-20b", fallback: true, why: "request failed" });
  });
  it("never answers with a model outside the set", async () => {
    for (const body of [{ pick: { choice: "m9" } }, {}, { pick: { choice: "anthropic/claude-opus-4.1" } }]) {
      const r = await pick({ ...args, fetchImpl: reply(200, body) });
      assert.ok(SET.includes(r.model));
    }
  });
});
