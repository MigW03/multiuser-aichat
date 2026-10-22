import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SMART_MODEL_ID } from "@mc/shared";
import { cleanTitle } from "./chat-title.ts";
import { titleNote, titlePrompt, type NoteTitleDeps } from "./note-title.ts";

const model = { provider: "anthropic" as const, model: "claude-sonnet-4-5" };

function deps(over: Partial<NoteTitleDeps> = {}) {
  const saved: { noteId: string; from: string; title: string }[] = [];
  const asked: string[] = [];
  const d: NoteTitleDeps = {
    source: async () => ({ question: "Which database should we use?", answer: "Supabase: Postgres and row-level security." }),
    getKey: async () => "key",
    ask: async (_p, _k, _m, _i, content) => {
      asked.push(content);
      return '"Supabase chosen as database."';
    },
    save: async (noteId, from, title) => void saved.push({ noteId, from, title }),
    ...over,
  };
  return { d, saved, asked };
}

describe("titleNote", () => {
  it("titles the note from the question and the answer, replacing the quick title", async () => {
    const { d, saved, asked } = deps();
    await titleNote("n1", "p1", "u1", "m1", "Supabase Postgres and row level", model, d);
    assert.deepEqual(saved, [{ noteId: "n1", from: "Supabase Postgres and row level", title: "Supabase chosen as database" }]);
    assert.match(asked[0]!, /^Question:\nWhich database should we use\?\n\nSaved answer:\nSupabase/);
  });
  it("keeps the quick title without a key, a readable message or an answer from the AI", async () => {
    for (const over of [{ getKey: async () => null }, { source: async () => null }, { ask: async () => { throw new Error("401"); } }, { ask: async () => '""' }] as Partial<NoteTitleDeps>[]) {
      const { d, saved } = deps(over);
      await titleNote("n1", "p1", "u1", "m1", "Quick", model, d);
      assert.deepEqual(saved, []);
    }
  });
  it("leaves Auto alone (it needs the person's Smart set)", async () => {
    const { d, saved, asked } = deps();
    await titleNote("n1", "p1", "u1", "m1", "Quick", { provider: "openrouter", model: SMART_MODEL_ID }, d);
    assert.deepEqual([saved, asked], [[], []]);
  });
});

describe("titlePrompt", () => {
  it("cuts long text and leaves out a missing question", () => {
    const p = titlePrompt({ question: "", answer: "a".repeat(5000) });
    assert.ok(p.startsWith("Saved answer:\n"));
    assert.equal(p.length, "Saved answer:\n".length + 2000);
  });
});

describe("cleanTitle with a longer limit", () => {
  it("keeps up to the limit, cut at a word", () => {
    const t = cleanTitle("Launch plan for the beta with owners and dates for each step", 60)!;
    assert.ok(t.length <= 60 && !t.endsWith(" "));
  });
});
