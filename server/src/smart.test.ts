import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SMART_MODEL_ID } from "@mc/shared";
import { answeredBy, cleanSmartSet, creditStatus, smartProviderOptions } from "./smart-rules.ts";

const usage = (budget: { remaining: number | null } | null, credits: { total: number; used: number } | null) => ({
  budget: budget && { limit: 10, spent: 0, remaining: budget.remaining, resetInterval: null, resetsAt: null },
  credits,
});

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
  it("rejects the router itself and lists that are too long", () => {
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

describe("answeredBy", () => {
  it("returns a real model id", () => assert.equal(answeredBy("anthropic/claude-haiku-4.5"), "anthropic/claude-haiku-4.5"));
  it("drops the router's own name, odd text and non-strings", () => {
    assert.equal(answeredBy(SMART_MODEL_ID), null);
    assert.equal(answeredBy("two words"), null);
    assert.equal(answeredBy(undefined), null);
    assert.equal(answeredBy(42), null);
  });
});

describe("smartProviderOptions", () => {
  it("asks the Jev Router to choose among the set", () => {
    assert.deepEqual(smartProviderOptions(["a/b", "c/d"]), { openrouter: { plugins: [{ id: "jev-router", models: ["a/b", "c/d"] }] } });
  });
});
