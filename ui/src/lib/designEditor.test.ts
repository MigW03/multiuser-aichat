import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claimWins, editorOf, evalMath, summarizeEdits, toHex } from "./designEditor.ts";

describe("one editor at a time", () => {
  const path = "app/designs/a.design.html";
  it("the person who started editing first is the editor", () => {
    const state = {
      u1: { at: 1, design: path, editing: true, since: 200, name: "Ana" },
      u2: { at: 1, design: path, editing: true, since: 100, name: "Ben" },
      u3: { at: 1, design: path, editing: false, name: "Cy" },
      u4: { at: 1, design: "other.design.html", editing: true, since: 1, name: "Di" },
    };
    assert.equal(editorOf(state, path)?.name, "Ben");
    assert.equal(editorOf(state, path, "u2")?.name, "Ana");
    assert.equal(editorOf({}, path), null);
  });
  it("a claim wins over a later one, and ties go to the smaller id", () => {
    assert.equal(claimWins("u1", 100, null), true);
    assert.equal(claimWins("u1", 100, { id: "u2", name: "B", since: 200 }), true);
    assert.equal(claimWins("u1", 300, { id: "u2", name: "B", since: 200 }), false);
    assert.equal(claimWins("u1", 200, { id: "u2", name: "B", since: 200 }), true);
  });
});

describe("summarizeEdits", () => {
  it("folds repeats and keeps the newest when it is long", () => {
    assert.equal(summarizeEdits(["moved Logo", "moved Logo", "resized Card", "moved Logo"]), "moved Logo; resized Card; moved Logo");
    assert.equal(summarizeEdits(["set gap of Hero", "set gap of Hero"]), "set gap of Hero");
    const long = summarizeEdits(Array.from({ length: 100 }, (_, i) => `changed text of Title ${i} to "something long enough"`), 200);
    assert.ok(long.length <= 200);
    assert.match(long, /Title 99/);
  });
});

describe("evalMath", () => {
  it("does arithmetic and nothing else", () => {
    assert.equal(evalMath("24+8"), 32);
    assert.equal(evalMath("120*2"), 240);
    assert.equal(evalMath("(10+6)/2"), 8);
    assert.equal(evalMath("-4 + 10px"), 6);
    assert.equal(evalMath("16"), 16);
    assert.equal(evalMath("1/0"), null);
    assert.equal(evalMath("alert(1)"), null);
    assert.equal(evalMath("2**3"), null);
    assert.equal(evalMath(""), null);
  });
});

describe("toHex", () => {
  it("reads plain colours for the picker", () => {
    assert.equal(toHex("#F0C"), "#ff00cc");
    assert.equal(toHex("rgb(61, 99, 160)"), "#3d63a0");
    assert.equal(toHex("linear-gradient(red, blue)"), null);
  });
});
