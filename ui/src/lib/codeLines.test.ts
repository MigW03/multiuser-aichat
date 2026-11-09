import assert from "node:assert/strict";
import { test } from "node:test";
import { codeLines, showLineNumbers } from "./codeLines.ts";

test("drops one trailing line break and keeps blank lines inside", () => {
  assert.deepEqual(codeLines("a\n\nb\n").map((l) => l.text), ["a", "", "b"]);
});

test("marks added and removed lines only in diff or patch blocks", () => {
  const code = "--- a\n+++ b\n-old\n+new\n same";
  assert.deepEqual(codeLines(code, "diff").map((l) => l.kind), ["plain", "plain", "del", "add", "plain"]);
  assert.deepEqual(codeLines(code, "patch").map((l) => l.kind), ["plain", "plain", "del", "add", "plain"]);
  assert.ok(codeLines(code, "ts").every((l) => l.kind === "plain"));
  assert.ok(codeLines(code).every((l) => l.kind === "plain"));
});

test("line numbers only past five lines", () => {
  assert.equal(showLineNumbers(5), false);
  assert.equal(showLineNumbers(6), true);
});
