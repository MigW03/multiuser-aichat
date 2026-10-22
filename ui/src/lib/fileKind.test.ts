import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { candidatePaths, cleanPath, dirOf, fileKind, findFilePaths, looksLikeFilePath, resolveRelative } from "./fileKind.ts";

describe("fileKind", () => {
  it("tells Markdown, HTML and the rest apart", () => {
    assert.equal(fileKind("proj/README.md"), "markdown");
    assert.equal(fileKind("proj/notes.MARKDOWN"), "markdown");
    assert.equal(fileKind("proj/site/index.html"), "html");
    assert.equal(fileKind("proj/old.HTM"), "html");
    assert.equal(fileKind("proj/src/app.ts"), "text");
    assert.equal(fileKind("proj/.gitignore"), "text");
    assert.equal(fileKind("proj/Makefile"), "text");
  });
});

describe("looksLikeFilePath", () => {
  it("accepts file paths written as code", () => {
    for (const ok of ["README.md", "src/app/index.html", "package.json", "./docs/plan.md", "ui/src/components/Shell.tsx", "my-file_2.txt"]) assert.ok(looksLikeFilePath(ok), ok);
  });
  it("skips everything else", () => {
    for (const no of ["", "npm run dev", "Next.js", "node.js", "v1.2", "e.g.", "https://example.com/a.html", "../secret.md", "a/../b.md", "src/", "image.png", "foo()", "a b.md", "x".repeat(300) + ".md"]) assert.ok(!looksLikeFilePath(no), no);
  });
});

describe("candidatePaths", () => {
  it("tries the path as written, then under each shared folder", () => {
    assert.deepEqual(candidatePaths("./src/a.md", ["web", "docs"]), ["src/a.md", "web/src/a.md", "docs/src/a.md"]);
  });
  it("does not repeat a folder the path already starts with", () => {
    assert.deepEqual(candidatePaths("web/src/a.md", ["web", "docs"]), ["web/src/a.md", "docs/web/src/a.md"]);
  });
  it("gives nothing for an empty path", () => {
    assert.deepEqual(candidatePaths("  ", ["web"]), []);
  });
  it("cleans leading dots and slashes", () => {
    assert.equal(cleanPath(" /./x//y.md "), "x/y.md");
  });
});

describe("resolveRelative", () => {
  it("follows links to siblings and parents", () => {
    assert.equal(resolveRelative("proj/docs", "other.md"), "proj/docs/other.md");
    assert.equal(resolveRelative("proj/docs", "./sub/a.md#part"), "proj/docs/sub/a.md");
    assert.equal(resolveRelative("proj/docs", "../README.md?x=1"), "proj/README.md");
    assert.equal(resolveRelative("proj/docs", "a%20b.md"), "proj/docs/a b.md");
  });
  it("starts a link with a slash at the shared folder", () => {
    assert.equal(resolveRelative("proj/docs", "/src/a.md"), "proj/src/a.md");
  });
  it("never leaves the shared folder", () => {
    assert.equal(resolveRelative("proj/docs", "../../x.md"), null);
    assert.equal(resolveRelative("proj", "../x.md"), null);
  });
  it("ignores addresses, anchors and mail links", () => {
    for (const href of ["https://example.com/a.md", "//example.com/a.md", "mailto:a@b.c", "#top", "", "javascript:alert(1)", "?x=1", "%zz.md"]) assert.equal(resolveRelative("proj", href), null, href);
  });
});

describe("dirOf", () => {
  it("is the folder a file is in", () => {
    assert.equal(dirOf("proj/docs/a.md"), "proj/docs");
    assert.equal(dirOf("a.md"), "");
  });
});

describe("findFilePaths", () => {
  it("lists the files an answer names as code, once each", () => {
    const text = "Edited `README.md` and `src/a.ts`, ran `npm test`, see `./README.md` and ``double``, plus ```fence.md``` and `Next.js`.";
    assert.deepEqual(findFilePaths(text), ["README.md", "src/a.ts"]);
  });
  it("ignores plain text that looks like a file", () => {
    assert.deepEqual(findFilePaths("Open README.md now"), []);
  });
});
