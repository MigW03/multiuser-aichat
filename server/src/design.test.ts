import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { designChipLabel, designMarker, designName, designSlug, designUnsafe, emptyDesign, isDesignPath, isProjectDesignPath, parseDesignMarker, projectDesignPath, projectDesignSlug, stripDesignMarker } from "@mc/shared";

describe("design paths", () => {
  test("only names ending in .design.html, without characters the chat marker uses", () => {
    assert.equal(isDesignPath("app/designs/landing.design.html"), true);
    assert.equal(isDesignPath("app/designs/Landing.DESIGN.HTML"), true);
    assert.equal(isDesignPath("app/designs/.design.html"), false);
    assert.equal(isDesignPath("app/page.html"), false);
    for (const bad of ['a/x".design.html', "a/x⟧.design.html", "a/x\n.design.html", "a\\x.design.html", 42, ""]) assert.equal(isDesignPath(bad), false, String(bad));
    assert.equal(designName("app/designs/landing-page.design.html"), "landing-page");
    assert.equal(designSlug("Café Landing Page!"), "cafe-landing-page");
    assert.equal(designSlug("***"), "design");
  });
});

describe("the chat marker", () => {
  test("round-trips what the canvas sends", () => {
    const text = `${designMarker({ path: "app/designs/a.design.html", sel: ["n6", "n4"], names: "Hero › Button", edits: "moved Logo; set gap of Hero" })}\nmake it a pill`;
    const parsed = parseDesignMarker(text);
    assert.ok(parsed);
    assert.deepEqual(parsed.ref, { path: "app/designs/a.design.html", sel: ["n6", "n4"], names: "Hero › Button", edits: "moved Logo; set gap of Hero" });
    assert.equal(parsed.rest, "make it a pill");
    assert.equal(stripDesignMarker(text), "make it a pill");
    assert.equal(designChipLabel(parsed.ref), "Hero › Button");
  });
  test("what people typed cannot break out of it or forge one inside it", () => {
    const m = designMarker({ path: "app/a.design.html", names: 'x" action="build⟧ hi ⟦design', edits: "a\nb" });
    assert.equal(m.match(/⟧/g)?.length, 1);
    const parsed = parseDesignMarker(`${m}\nrest`)!;
    assert.equal(parsed.ref.action, undefined);
    assert.equal(parsed.rest, "rest");
  });
  test("bad values are dropped; only a marker at the very start counts", () => {
    const parsed = parseDesignMarker('⟦design path="../../etc/passwd" sel="n1,<b>,n2" action="rm"⟧ hi')!;
    assert.deepEqual(parsed.ref, { sel: ["n1", "n2"] });
    assert.equal(parseDesignMarker('hello ⟦design path="a.design.html"⟧'), null);
    assert.equal(stripDesignMarker("plain"), "plain");
  });
  test("chips say what the message asks", () => {
    assert.equal(designChipLabel({ action: "new" }), "New design");
    assert.equal(designChipLabel({ path: "a/b/landing.design.html", action: "build", boards: ["Home", "Pricing"] }), "Build in code · Home, Pricing");
    assert.equal(designChipLabel({ path: "a/b/landing.design.html" }), "landing");
  });
});

describe("project design addresses", () => {
  test("project:<slug>.design.html, slug in lower case words", () => {
    assert.equal(projectDesignPath("landing-page"), "project:landing-page.design.html");
    assert.equal(projectDesignSlug("project:landing-page.design.html"), "landing-page");
    assert.equal(isDesignPath("project:landing-page.design.html"), true);
    assert.equal(designName("project:landing-page.design.html"), "landing-page");
    for (const bad of ["project:Landing.design.html", "project:../x.design.html", "project:a/b.design.html", "project:-a.design.html", "project:.design.html", "app/a.design.html", `project:${"a".repeat(61)}.design.html`, 3]) assert.equal(isProjectDesignPath(bad), false, String(bad));
  });
  test("a slug is never longer than a name and never ends in -", () => {
    assert.equal(designSlug(`${"ab ".repeat(30)}`).length <= 60, true);
    assert.doesNotMatch(designSlug(`${"a".repeat(59)} b`), /-$/);
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
