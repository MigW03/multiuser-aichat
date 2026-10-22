import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { answerPreview, draftFromAction, GENUI_MAX_BLOCKS, splitAnswer } from "@mc/shared";
import { createParser } from "@openuidev/react-lang";
import { genLibrary } from "../genui/library.tsx";

const block = (code: string) => "```openui-lang\n" + code + "\n```";

test("plain Markdown stays one Markdown part", () => {
  assert.deepEqual(splitAnswer("Hi **there**\n\n```js\nx()\n```"), [{ kind: "markdown", text: "Hi **there**\n\n```js\nx()\n```" }]);
});

test("a block between text becomes a UI part, in order", () => {
  const parts = splitAnswer(`Before\n\n${block('root = Stack([t])\nt = Text("hi")')}\n\nAfter`);
  assert.deepEqual(
    parts.map((p) => p.kind),
    ["markdown", "ui", "markdown"],
  );
  assert.deepEqual(parts[1], { kind: "ui", code: 'root = Stack([t])\nt = Text("hi")', closed: true });
});

test("a block still being written is open", () => {
  const parts = splitAnswer("Here:\n```openui-lang\nroot = Stack([");
  assert.deepEqual(parts.at(-1), { kind: "ui", code: "root = Stack([", closed: false });
});

test("an openui fence inside another code block is left as code", () => {
  const text = "````markdown\n" + block("root = Stack([])") + "\n````\nafter";
  assert.deepEqual(splitAnswer(text), [{ kind: "markdown", text }]);
  const tilde = "~~~\n" + block("root = Stack([])") + "\n~~~";
  assert.deepEqual(splitAnswer(tilde), [{ kind: "markdown", text: tilde }]);
});

test("only the first blocks are drawn, and very long ones stay code", () => {
  const many = Array.from({ length: GENUI_MAX_BLOCKS + 2 }, () => block('root = Stack([Text("x")])')).join("\n");
  assert.equal(splitAnswer(many).filter((p) => p.kind === "ui").length, GENUI_MAX_BLOCKS);
  const long = splitAnswer(block(`root = Stack([Text("${"a".repeat(25_000)}")])`));
  assert.equal(long[0]!.kind, "markdown");
});

test("a reply draft shows every answered field and any details", () => {
  const state = { trip: { destination: { value: "Lisbon", componentType: undefined }, travel_dates: { value: "May 3-7" }, notes: { value: "" } } };
  assert.equal(draftFromAction("Plan it", state, "trip"), "Plan it\n- Destination: Lisbon\n- Travel dates: May 3-7");
  assert.equal(draftFromAction("Approve", {}, undefined, { orderId: 42 }), 'Approve\nDetails: {"orderId":42}');
  assert.equal(draftFromAction("Pick B", { other: { x: { value: "y" } } }), "Pick B");
});

test("previews name a visual instead of showing its code", () => {
  assert.equal(answerPreview(`Look:\n${block("root = Stack([])")}`), "Look: [visual]");
});

test("the committed spec matches the library (run `npm run genui:spec -w ui` after changing it)", () => {
  const committed = readFileSync(new URL("../../../shared/src/genui-spec.json", import.meta.url), "utf8");
  assert.equal(committed, `${JSON.stringify(genLibrary.toSpec(), null, 2)}\n`);
});

test("the prompt's example and the usual shapes parse against the library", () => {
  const parser = createParser(genLibrary.toJSONSchema(), genLibrary.root);
  const programs = [
    `root = Stack([table, choice])
table = Table(["", "Supabase", "Firebase"], [["Database", "Postgres", "NoSQL"], ["Pricing from", "$25/mo", "Pay as you go"]])
choice = Choice("Which one should we use?", [optA, optB])
optA = Option("Let's go with Supabase", "SQL and row-level security")
optB = Option("Let's go with Firebase", "Simpler realtime")`,
    `root = Stack([stats, chart, plan])
stats = Stack([Stat("Signups", 1280, "+12%"), Stat("Churn", "2.1%")], "row")
chart = BarChart(["Jan", "Feb"], [Series("2025", [3, 5]), Series("2026", [4, 7])], "k")
plan = Checklist([Task("Ship beta", "Ana", true), Task("Write docs", "Ben")], "Next steps")`,
    `root = Stack([card, form])
card = Card("Heads up", [Callout("warning", "Breaking change", "Run the **migration** first"), Buttons([Button("Show me how", @ToAssistant("How do I run the migration?"), "primary"), Button("Copy", @CopyText("npm run migrate"))])])
form = Form("trip", [Input("destination", "Where to?"), Select("budget", "Budget", ["Low", "High"])], "Plan my trip")`,
  ];
  for (const p of programs) {
    const result = parser.parse(p);
    assert.ok(result.root, p);
    assert.deepEqual(
      result.meta.errors.filter((e) => e.severity !== "warning").map((e) => `${e.code}: ${e.message}`),
      [],
      p,
    );
  }
});
