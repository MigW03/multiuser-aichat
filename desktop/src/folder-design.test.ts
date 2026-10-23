import { designUnsafe, emptyDesign } from "@mc/shared";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { designEdit, designRead, designWrite } from "./folder-design.ts";
import { FolderError } from "./folder-fs.ts";
import { nameItems, type Item } from "./folder-items.ts";

const fails = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof FolderError && e.code === code, `expected ${code}`);
};

let root = "";
let items: Item[] = [];
const at = (path: string) => `${items[0]!.name}/${path}`;

before(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mc-design-")));
  root = join(base, "app");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/page.tsx"), "export {};\n");
  mkdirSync(join(base, "outside"));
  writeFileSync(join(base, "outside/x.design.html"), emptyDesign());
  symlinkSync(join(base, "outside"), join(root, "linked"));
  items = nameItems([{ abs: root, kind: "dir" }]);
});

describe("design files on the host", () => {
  test("a new design is created (with its folder) and read back with its hash", async () => {
    const w = await designWrite(items, { path: at("designs/landing.design.html"), content: emptyDesign(), baseSha: null });
    assert.equal(w.created, true);
    assert.equal(w.path, at("designs/landing.design.html"));
    assert.equal(readFileSync(join(root, "designs/landing.design.html"), "utf8"), emptyDesign());
    const r = await designRead(items, { path: at("designs/landing.design.html") });
    assert.equal(r.text, emptyDesign());
    assert.equal(r.sha, w.sha);
    assert.match(r.sha, /^[0-9a-f]{64}$/);
  });

  test("creating over an existing design is refused", async () => {
    await fails(designWrite(items, { path: at("designs/landing.design.html"), content: emptyDesign("phone"), baseSha: null }), "exists");
  });

  test("a save names the version it was made from; a changed file is not overwritten", async () => {
    const r = await designRead(items, { path: at("designs/landing.design.html") });
    const next = r.text.replace("Desktop", "Home");
    const w = await designWrite(items, { path: at("designs/landing.design.html"), content: next, baseSha: r.sha });
    assert.notEqual(w.sha, r.sha);
    await fails(designWrite(items, { path: at("designs/landing.design.html"), content: r.text, baseSha: r.sha }), "stale");
    assert.equal(readFileSync(join(root, "designs/landing.design.html"), "utf8"), next);
  });

  test("the AI replaces an existing design only after reading it", async () => {
    await fails(designWrite(items, { path: at("designs/landing.design.html"), content: emptyDesign() }), "exists");
    const w = await designWrite(items, { path: at("designs/landing.design.html"), content: emptyDesign(), hadRead: true });
    assert.equal(w.created, false);
  });

  test("an edit replaces exact text and saves at once", async () => {
    const w = await designEdit(items, { path: at("designs/landing.design.html"), oldString: 'data-board="Desktop"', newString: 'data-board="Start"' });
    assert.equal(w.created, false);
    assert.match(readFileSync(join(root, "designs/landing.design.html"), "utf8"), /data-board="Start"/);
    await fails(designEdit(items, { path: at("designs/none.design.html"), oldString: "a", newString: "b" }), "not_found");
  });

  test("only design files, inside the shared folder, without links", async () => {
    await fails(designWrite(items, { path: at("src/page.tsx"), content: "x", baseSha: null }), "bad_request");
    await fails(designRead(items, { path: at("src/page.tsx") }), "bad_request");
    await assert.rejects(designWrite(items, { path: "../x.design.html", content: emptyDesign(), baseSha: null }), FolderError);
    await fails(designRead(items, { path: at("linked/x.design.html") }), "excluded");
    await fails(designWrite(items, { path: at(".git/a.design.html"), content: emptyDesign(), baseSha: null }), "excluded");
  });

  test("active content and secrets are refused, and nothing is written", async () => {
    const bad = [
      `${emptyDesign()}<script>alert(1)</script>`,
      `<section data-board="A" onclick="x()"></section>`,
      `<a href="&#106;avascript&colon;alert(1)">x</a>`,
      `<img src="https://tracker.example/p.png">`,
      `<div style="background: url(https://x.example/a.png)"></div>`,
      `<iframe src="data:image/png;base64,AA"></iframe>`,
    ];
    for (const content of bad) await fails(designWrite(items, { path: at("designs/bad.design.html"), content, baseSha: null }), "bad_request");
    const key = ["sk", "ant", "api03", "x".repeat(40)].join("-");
    await fails(designWrite(items, { path: at("designs/bad.design.html"), content: `<p>${key}</p>`, baseSha: null }), "secrets");
    await fails(designRead(items, { path: at("designs/bad.design.html") }), "not_found");
  });
});

describe("designUnsafe", () => {
  test("refuses what can run or load from outside, however it is spelled", () => {
    for (const html of [
      "<script>x</script>",
      "<SCRIPT >x</SCRIPT>",
      "<svg><foreignObject></foreignObject></svg>",
      '<div data-name=">" onclick="alert(1)">x</div>',
      '<img/onerror=alert(1) src="data:image/png;base64,A">',
      '<a href="java\tscript:alert(1)">x</a>',
      '<a href="data:text/html,<b>hi</b>">x</a>',
      '<div style="background: url&#40;http://x)"></div>',
      '<div style="background: \\75 rl(http://x)"></div>',
      '<div style="width: expression(alert(1))"></div>',
      '<img srcset="a.png 1x">',
      '<form action="/x"></form>',
    ]) {
      assert.ok(designUnsafe(html), html);
    }
  });

  test("lets plain designs through: inline styles, inline pictures, code shown as text", () => {
    for (const html of [
      emptyDesign(),
      '<img alt="dot" src="data:image/png;base64,AAAA">',
      `<div style='background: url("data:image/webp;base64,AA") center / cover'></div>`,
      "<h1>JavaScript: the good parts</h1>",
      "<p>&lt;script&gt; is shown as code</p>",
      '<p data-name="on fire">Hot</p>',
      '<a href="#pricing" style="color: #3d63a0">See pricing</a>',
      "<p>C:\\Users\\me</p>",
    ]) {
      assert.equal(designUnsafe(html), null, html);
    }
  });
});
