import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { replaceText } from "./edit-match.ts";
import { FolderError } from "./folder-fs.ts";

const fails = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof FolderError && e.code === code, `expected ${code}`);

describe("replaceText", () => {
  test("exact match, one place", () => {
    assert.equal(replaceText("a = 1;\nb = 2;\n", "b = 2;", "b = 3;"), "a = 1;\nb = 3;\n");
  });

  test("refuses no-ops, empty and missing text", () => {
    fails(() => replaceText("x", "x", "x"), "bad_request");
    fails(() => replaceText("x", "", "y"), "bad_request");
    fails(() => replaceText("abc", "zzz", "y"), "no_match");
  });

  test("more than one place needs replaceAll", () => {
    fails(() => replaceText("a\nb\na\n", "a", "z"), "ambiguous");
    assert.equal(replaceText("a\nb\na\n", "a", "z", true), "z\nb\nz\n");
  });

  test("wrong indentation and trailing spaces", () => {
    const src = "function f() {\n    return 1;   \n}\n";
    assert.equal(replaceText(src, "  return 1;\n", "    return 2;\n"), "function f() {\n    return 2;\n}\n");
  });

  test("block anchored on its first and last line, middle slightly off", () => {
    const src = "if (a) {\n  doThing(1, 2);\n  other();\n}\nrest\n";
    const out = replaceText(src, "if (a) {\n  doThing(1,2);\n  other();\n}", "if (a) {\n  done();\n}");
    assert.equal(out, "if (a) {\n  done();\n}\nrest\n");
  });

  test("block anchor refuses a middle that is nothing alike", () => {
    const src = "start\nxxxxxxxxxxxxxxxx\nend\n";
    fails(() => replaceText(src, "start\nqqqqqqqqqqqqqqqqqqqqqqqq\nend", "n"), "no_match");
  });

  test("collapsed whitespace inside a line", () => {
    assert.equal(replaceText("const  a   =  1;\n", "const a = 1;", "const a = 2;"), "const a = 2;\n");
  });

  test("a block pasted at another nesting level", () => {
    const src = "class A {\n    run() {\n        go();\n        stop();\n    }\n}\n";
    const out = replaceText(src, "go();\nstop();", "halt();");
    assert.equal(out, "class A {\n    run() {\n        halt();\n    }\n}\n");
  });

  test("escape sequences written literally", () => {
    assert.equal(replaceText('say("a")\nnext\n', 'say(\\"a\\")\\nnext', 'say("b")'), 'say("b")\n');
  });

  test("blank space around the text to find", () => {
    assert.equal(replaceText("x = 1;\ny = 2;\n", "\n\nx = 1;  ", "x = 5;"), "x = 5;\ny = 2;\n");
  });

  test("keeps CRLF line endings and a byte order mark", () => {
    const src = "\uFEFFone\r\ntwo\r\nthree\r\n";
    assert.equal(replaceText(src, "two\nthree", "2\n3"), "\uFEFFone\r\n2\r\n3\r\n");
    assert.equal(replaceText(src, "two\r\n", "TWO\r\n"), "\uFEFFone\r\nTWO\r\nthree\r\n");
  });

  test("replaceAll with a tolerant match", () => {
    assert.equal(replaceText("  a();\nb();\n  a();\n", "a();", "c();", true), "  c();\nb();\n  c();\n");
  });

  test("a huge near-match search stays cheap", () => {
    const big = Array.from({ length: 60_000 }, (_, i) => (i % 3 === 0 ? "start" : "line " + i)).join("\n");
    const t0 = Date.now();
    fails(() => replaceText(big, "start\nsomething else\nthat never ends the block\nend", "x"), "no_match");
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  });

  test("replacement text containing $ patterns is taken literally", () => {
    assert.equal(replaceText("price\n", "price", "$& $1 $$"), "$& $1 $$\n");
  });
});
