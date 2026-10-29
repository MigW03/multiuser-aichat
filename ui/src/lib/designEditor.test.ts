import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { describe, it } from "node:test";
import { alignOf, alignStyle, claimWins, editorOf, evalMath, paddingOf, paddingStyle, sameDesignPath, strokeOf, strokeStyle, summarizeEdits, toHex } from "./designEditor.ts";

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

describe("design paths from the AI", () => {
  it("match with or without the shared folder's name, never a different file", () => {
    assert.ok(sameDesignPath("app/designs/a.design.html", "app/designs/a.design.html"));
    assert.ok(sameDesignPath("designs/a.design.html", "app/designs/a.design.html"));
    assert.ok(!sameDesignPath("designs/ba.design.html", "app/designs/a.design.html") && !sameDesignPath("a.design.html", "app/designs/ba.design.html"));
    assert.ok(!sameDesignPath(undefined, "app/designs/a.design.html"));
  });
});

describe("Figma-like controls over inline CSS", () => {
  const doc = new JSDOM("").window.document;
  const styled = (css: string) => {
    const el = doc.createElement("div");
    el.setAttribute("style", css);
    return el.style;
  };

  it("reads a stroke from any border spelling", () => {
    assert.deepEqual(strokeOf(styled("border: 1px solid #e5e5e5")), { color: "#e5e5e5", width: 1, style: "solid", sides: "all" });
    assert.equal(strokeOf(styled("border-bottom: 2px dashed red"))?.sides, "bottom");
    assert.equal(strokeOf(styled("border-top: 1px solid red; border-left: 1px solid red"))?.sides, "custom");
    assert.equal(strokeOf(styled("padding: 4px")), null);
    assert.equal(strokeOf(styled("border: none")), null);
  });

  it("writes a stroke as one plain declaration and clears the rest", () => {
    const all = strokeStyle({ color: "#111111", width: 2, style: "dashed", sides: "all" });
    assert.equal(all.border, "2px dashed #111111");
    assert.equal(all["border-top"], null);
    assert.equal(strokeStyle({ color: "#111111", width: 1, style: "solid", sides: "left" })["border-left"], "1px solid #111111");
    const custom = strokeStyle({ color: "red", width: 3, style: "solid", sides: "custom" }, styled("border-top: 1px solid red; border-left: 1px solid red"));
    assert.equal(custom["border-top"], "3px solid red");
    assert.equal(custom["border-left"], "3px solid red");
    assert.equal(custom["border-right"], null);
    assert.ok(Object.values(strokeStyle(null)).every((v) => v === null));
  });

  it("reads and writes padding in the shortest form", () => {
    assert.deepEqual(paddingOf(styled("padding: 8px 16px")), [8, 16, 8, 16]);
    assert.deepEqual(paddingOf(styled("padding-left: 4px")), [0, 0, 0, 4]);
    assert.equal(paddingStyle([8, 8, 8, 8]).padding, "8px");
    assert.equal(paddingStyle([8, 16, 8, 16]).padding, "8px 16px");
    assert.equal(paddingStyle([1, 2, 3, 4]).padding, "1px 2px 3px 4px");
    assert.equal(paddingStyle([0, 0, 0, 0]).padding, null);
  });

  it("maps the 3x3 alignment box onto flex and grid", () => {
    assert.deepEqual(alignStyle("row", "center", "end", false), { "justify-content": "center", "align-items": "flex-end" });
    assert.deepEqual(alignStyle("column", "start", "center", false), { "justify-content": "center", "align-items": null });
    assert.deepEqual(alignStyle("column", "end", "start", true), { "justify-content": "space-between", "align-items": "flex-end" });
    assert.deepEqual(alignOf(styled("display:flex; justify-content:center; align-items:flex-end"), "row"), { x: "center", y: "end", auto: false });
    assert.deepEqual(alignOf(styled("display:flex; flex-direction:column; justify-content:space-between"), "column"), { x: "start", y: "start", auto: true });
    assert.deepEqual(alignOf(styled("display:grid; justify-items:center"), "grid"), { x: "center", y: "start", auto: false });
  });
});
