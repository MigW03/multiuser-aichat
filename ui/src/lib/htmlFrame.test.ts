import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { FRAME_CSP, FRAME_SANDBOX, frameDocument } from "./htmlFrame.ts";

const purify = createDOMPurify(new JSDOM("").window as unknown as Window & typeof globalThis);
const frame = (html: string) => frameDocument(html, purify);
const parsed = (html: string) => new JSDOM(frame(html)).window.document;

describe("frameDocument", () => {
  it("starts with the doctype and the policy, before anything from the file", () => {
    const out = frame("<!doctype html><html><head><title>t</title></head><body>hi</body></html>");
    assert.ok(out.startsWith(`<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`));
    assert.equal(out.match(/<!doctype/gi)?.length, 1);
    assert.equal(parsed("<p>x</p>").compatMode, "CSS1Compat");
  });

  it("keeps the file's own look: styles, text, inline pictures", () => {
    const d = parsed(`<html><head><style>h1{color:red}</style></head><body><h1 style="color:blue">Hello</h1><img alt="dot" src="data:image/png;base64,AAAA"></body></html>`);
    assert.equal(d.querySelector("style")?.textContent, "h1{color:red}");
    assert.equal(d.querySelector("h1")?.textContent, "Hello");
    assert.equal(d.querySelector("h1")?.getAttribute("style"), "color:blue");
    assert.ok(d.querySelector("img")?.getAttribute("src")?.startsWith("data:image/png"));
  });

  it("removes scripts and event handlers", () => {
    const d = parsed(`<body onload="x()"><script>alert(1)</script><img src="data:image/png;base64,AA" onerror="x()"><p onclick="x()">a</p><svg onload="x()"><script>x()</script></svg><noscript>n</noscript></body>`);
    assert.equal(d.querySelectorAll("script, noscript").length, 0);
    for (const el of d.querySelectorAll("*")) for (const a of el.getAttributeNames()) assert.ok(!a.startsWith("on"), `${el.nodeName} ${a}`);
  });

  it("removes redirects, frames, forms, objects and external pointers", () => {
    const d = parsed(
      `<head><meta http-equiv="refresh" content="0;url=https://evil.test"><link rel="stylesheet" href="https://evil.test/a.css"><base href="https://evil.test/"></head>` +
        `<body><iframe src="https://evil.test"></iframe><form action="https://evil.test"><input name="p"><button>go</button></form><object data="x"></object><embed src="x"><video src="x"></video></body>`,
    );
    assert.equal(d.querySelectorAll("iframe, form, input, button, object, embed, video, link").length, 0);
    const metas = [...d.querySelectorAll("meta")].map((m) => m.getAttribute("http-equiv") ?? m.getAttribute("name"));
    assert.deepEqual(metas, ["Content-Security-Policy", "color-scheme"]);
    assert.deepEqual([...d.querySelectorAll("base")].map((b) => b.getAttribute("href")), [null]);
  });

  it("leaves links as text that point nowhere, and drops remote picture sources", () => {
    const d = parsed(`<a href="https://evil.test" target="_top" ping="https://evil.test/p">go</a><a href="#x">in</a><img src="https://evil.test/a.png" alt="a"><img src="logo.png" alt="b"><svg><use href="https://evil.test/s.svg#a"></use></svg>`);
    for (const a of d.querySelectorAll("a")) assert.equal(a.getAttribute("href"), null);
    assert.equal(d.querySelector("a")?.getAttribute("target"), null);
    assert.equal(d.querySelector("a")?.getAttribute("ping"), null);
    for (const img of d.querySelectorAll("img")) assert.equal(img.getAttribute("src"), null);
    assert.equal(d.querySelector("use")?.getAttribute("href") ?? null, null);
  });

  it("survives broken and empty input", () => {
    assert.ok(frame("").includes("Content-Security-Policy"));
    assert.ok(frame("<div><b>unclosed").includes("unclosed"));
    assert.equal(parsed("<p>plain text only</p>").body.textContent, "plain text only");
  });

  it("the policy allows no script, network or frame", () => {
    assert.match(FRAME_CSP, /^default-src 'none'/);
    assert.ok(!/script-src|connect-src|frame-src|https?:/.test(FRAME_CSP));
    assert.equal(FRAME_SANDBOX, "");
  });
});
