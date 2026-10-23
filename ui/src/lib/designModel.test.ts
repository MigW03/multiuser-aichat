import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { boardHash, boardsOf, byNid, changedLayers, cleanStyle, layerName, layerPath, parseDesign, parseStyle, serializeDesign, styleGet, styleSet } from "./designModel.ts";

const win = new JSDOM("").window as unknown as Window & typeof globalThis;
const purify = createDOMPurify(win);
const parse = (html: string) => parseDesign(html, win.document, purify);

const DESIGN = `<!-- Nido design. Open it in Nido's design mode. -->
<section data-board="Home" data-nid="b1" data-x="0" data-y="0" data-w="800" style="display: flex; flex-direction: column; gap: 24px">
  <header data-nid="n2" data-name="Header" style="display: flex; gap: 16px">
    <p data-nid="n3" style="margin: 0; color: #f0c">Nido</p>
    <a data-nid="n4" href="#" style="padding: 8px">Start</a>
  </header>
</section>
`;

describe("parseDesign", () => {
  it("reads boards and layers, and writes the same file back", () => {
    const { root, removed, idsFixed } = parse(DESIGN);
    assert.deepEqual(boardsOf(root).map((b) => b.getAttribute("data-board")), ["Home"]);
    assert.equal(byNid(root, "n3")?.textContent, "Nido");
    assert.deepEqual(removed, []);
    assert.equal(idsFixed, false);
    assert.equal(serializeDesign(root), DESIGN);
  });

  it("removes scripts, handlers, frames, forms and outside pictures, and says what it removed", () => {
    const { root, removed } = parse(`<section data-board="A" data-nid="b1">
<script>alert(1)</script><img data-nid="n2" src="https://x.example/p.png" onerror="x()"><iframe src="https://x"></iframe><form action="/x"><input></form>
<a data-nid="n3" href="javascript:alert(1)">x</a><div data-nid="n4" style="background: url(https://x/a.png); color: red"></div>
<img data-nid="n5" src="data:image/png;base64,AAAA"></section>`);
    const html = root.innerHTML;
    assert.doesNotMatch(html, /<script|<iframe|<form|onerror|javascript:|https:\/\/x/);
    assert.equal(byNid(root, "n4")?.getAttribute("style"), "color: red");
    assert.equal(byNid(root, "n5")?.getAttribute("src"), "data:image/png;base64,AAAA");
    assert.ok(removed.length > 0);
  });

  it("gives missing and repeated ids new ones", () => {
    const { root, idsFixed } = parse(`<section data-board="A"><p data-nid="n1">a</p><p data-nid="n1">b</p><p>c</p></section>`);
    assert.equal(idsFixed, true);
    const ids = [...root.querySelectorAll("[data-nid]")].map((e) => e.getAttribute("data-nid"));
    assert.equal(new Set(ids).size, 4);
  });
});

describe("inline styles", () => {
  it("splits declarations without breaking inline pictures", () => {
    assert.deepEqual(parseStyle("color: red; background: url(data:image/png;base64,AA;BB) center;gap:4px"), [
      ["color", "red"],
      ["background", "url(data:image/png;base64,AA;BB) center"],
      ["gap", "4px"],
    ]);
  });

  it("keeps inline pictures and drops outside ones, scripts and CSS escapes", () => {
    assert.equal(cleanStyle("background: url(data:image/png;base64,AA); color: red"), "background: url(data:image/png;base64,AA); color: red");
    assert.equal(cleanStyle("background: url(https://x/a.png); color: red"), "color: red");
    assert.equal(cleanStyle("width: expression(alert(1)); color: red"), "color: red");
    assert.equal(cleanStyle("background: \\75 rl(https://x); color: red"), "color: red");
  });

  it("changes one declaration and keeps the rest as written", () => {
    const { root } = parse(DESIGN);
    const p = byNid(root, "n3")!;
    styleSet(p, { "font-size": "20px", margin: null });
    assert.equal(p.getAttribute("style"), "color: #f0c; font-size: 20px");
    assert.equal(styleGet(p, "color"), "#f0c");
    styleSet(p, { color: null, "font-size": null });
    assert.equal(p.hasAttribute("style"), false);
  });
});

describe("layers", () => {
  it("names layers from data-name, text or what they are", () => {
    const { root } = parse(DESIGN);
    assert.equal(layerName(byNid(root, "n2")!), "Header");
    assert.equal(layerName(byNid(root, "n3")!), "Nido");
    assert.equal(layerPath(byNid(root, "n4")!), "Header › Start");
  });

  it("a board's hash changes with its design, not with its place or code link", () => {
    const { root } = parse(DESIGN);
    const b = boardsOf(root)[0]!;
    const h = boardHash(b);
    b.setAttribute("data-x", "500");
    b.setAttribute("data-code", "app/src/Home.tsx");
    assert.equal(boardHash(b), h);
    styleSet(byNid(root, "n3")!, { color: "blue" });
    assert.notEqual(boardHash(b), h);
  });

  it("finds the layers an AI change touched", () => {
    const before = parse(DESIGN).root;
    const after = parse(DESIGN.replace("Start", "Begin").replace("gap: 16px", "gap: 24px")).root;
    assert.deepEqual(changedLayers(before, after).sort(), ["n2", "n4"]);
  });
});
