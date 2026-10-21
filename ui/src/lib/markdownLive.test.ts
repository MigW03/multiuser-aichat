import assert from "node:assert/strict";
import { test } from "node:test";
import { styleMarkdown, type StyledLine } from "./markdownLive.ts";

const join = (lines: StyledLine[]) => lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n");
const kinds = (text: string) => styleMarkdown(text).map((l) => l.kind ?? "-");

test("the pieces always add back up to the typed text", () => {
  const samples = [
    "",
    "\n",
    "plain",
    "a **b** `c` ~~d~~ *e* f",
    "- one\n  - two\n1. three\n> quote\n# head\n",
    "```diff\n- a\n+ b\n```\nafter",
    "```js\nunclosed `tick` **x**",
    "**unclosed and `half",
    "  ~~~\ncode\n~~~~\n",
  ];
  for (const s of samples) assert.equal(join(styleMarkdown(s)), s);
});

test("inline marks are dimmed and their contents styled", () => {
  const [line] = styleMarkdown("use **bold** and `code` and *it*");
  assert.deepEqual(
    line!.spans.filter((s) => s.kind && s.kind !== "mark").map((s) => [s.kind, s.text]),
    [["bold", "bold"], ["code", "code"], ["italic", "it"]],
  );
});

test("inline marks need a closing mark and no inner padding", () => {
  for (const s of ["2 * 3 * 4", "**not closed", "** spaced **", "snake_case_name"]) {
    assert.ok(styleMarkdown(s)[0]!.spans.every((x) => !x.kind), s);
  }
});

test("code inside backticks is not parsed further", () => {
  const [line] = styleMarkdown("`**x**`");
  assert.deepEqual(line!.spans.map((s) => s.kind), ["mark", "code", "mark"]);
});

test("a fenced block covers its fences and everything between", () => {
  const lines = styleMarkdown("hi\n```ts\nconst a = **1**;\n```\nbye");
  assert.deepEqual(kinds("hi\n```ts\nconst a = **1**;\n```\nbye"), ["-", "fence", "code", "fence", "-"]);
  assert.equal(lines[1]!.first, true);
  assert.equal(lines[3]!.last, true);
  assert.equal(lines[2]!.spans.length, 1);
});

test("an open fence runs to the end of the text", () => {
  const lines = styleMarkdown("```\na\nb");
  assert.deepEqual(kinds("```\na\nb"), ["fence", "code", "code"]);
  assert.equal(lines[0]!.first, true);
  assert.equal(lines[2]!.last, true);
});

test("a shorter or different fence does not close a block", () => {
  assert.deepEqual(kinds("````\n```\n~~~\n````"), ["fence", "code", "code", "fence"]);
});

test("a fence line with backticks after it is inline code, not a fence", () => {
  assert.deepEqual(kinds("```x``` y"), ["-"]);
});

test("diff blocks tint added and removed lines, not file headers", () => {
  assert.deepEqual(kinds("```diff\n--- a\n+++ b\n- x\n+ y\n z\n```"), ["fence", "code", "code", "del", "add", "code", "fence"]);
  assert.deepEqual(kinds("```js\n- x\n+ y\n```"), ["fence", "code", "code", "fence"]);
});

test("headings, quotes and lists", () => {
  assert.deepEqual(kinds("# a\n## b\n#no\n> q\n- l"), ["heading", "heading", "-", "quote", "-"]);
  const [, list] = styleMarkdown("x\n  12. item **b**");
  assert.deepEqual(list!.spans.filter((s) => s.kind).map((s) => s.kind), ["list", "mark", "bold", "mark"]);
});
