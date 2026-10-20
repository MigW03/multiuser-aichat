import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanTitle, firstWords, nameChat, type NameDeps } from "./chat-title.ts";

describe("cleanTitle", () => {
  it("strips quotes, markdown and end punctuation", () => {
    assert.equal(cleanTitle('"Lisbon trip plan."'), "Lisbon trip plan");
    assert.equal(cleanTitle("**Budget review**!"), "Budget review");
    assert.equal(cleanTitle("Title: Release notes"), "Release notes");
  });
  it("keeps apostrophes inside words and takes the first line", () => {
    assert.equal(cleanTitle("Don't panic\nIgnore this second line"), "Don't panic");
  });
  it("cuts long names at a word", () => {
    const t = cleanTitle("A very long chat title that goes on and on past forty characters");
    assert.ok(t && t.length <= 40 && !t.endsWith(" "));
  });
  it("gives null for nothing usable", () => {
    assert.equal(cleanTitle(' "" ... '), null);
    assert.equal(cleanTitle(""), null);
  });
});

describe("nameChat", () => {
  const run = async (over: Partial<NameDeps>, model: { provider: "openai"; model: string } | null) => {
    const saved: string[] = [];
    const deps: NameDeps = { getKey: async () => "key", generate: async () => "Lisbon trip", save: async (_c, t) => void saved.push(t), ...over };
    await nameChat("c1", "u1", "Plan a 3 day trip to Lisbon   please", model, deps);
    return saved;
  };
  const model = { provider: "openai" as const, model: "m" };
  it("saves the AI name", async () => assert.deepEqual(await run({}, model), ["Lisbon trip"]));
  it("falls back to the first words when the AI fails", async () => assert.deepEqual(await run({ generate: async () => { throw new Error("boom"); } }, model), ["Plan a 3 day trip to Lisbon please"]));
  it("falls back when the AI gives nothing usable", async () => assert.deepEqual(await run({ generate: async () => null }, model), ["Plan a 3 day trip to Lisbon please"]));
  it("falls back when the key is gone", async () => assert.deepEqual(await run({ getKey: async () => null }, model), ["Plan a 3 day trip to Lisbon please"]));
  it("uses the first words when there is no model to ask", async () => assert.deepEqual(await run({ generate: async () => { throw new Error("must not be called"); } }, null), ["Plan a 3 day trip to Lisbon please"]));
  it("does not start a second call while one is running", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deps: NameDeps = { getKey: async () => "k", generate: async () => { calls++; await gate; return "A"; }, save: async () => {} };
    const first = nameChat("c2", "u", "hi", model, deps);
    await nameChat("c2", "u", "again", model, deps);
    release();
    await first;
    assert.equal(calls, 1);
  });
});

describe("firstWords", () => {
  it("collapses whitespace and caps at 40", () => assert.equal(firstWords("a  b\n c".repeat(20)).length <= 40, true));
});
