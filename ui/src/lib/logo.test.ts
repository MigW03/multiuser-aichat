import assert from "node:assert/strict";
import test from "node:test";
import { appIconSvg, faviconHref, faviconSvg, logoShapes, logoSvg } from "./logo.ts";

test("the mark is one ring and three eggs", () => {
  const shapes = logoShapes("#9db38f", "#1f241b");
  assert.equal(shapes.match(/<circle/g)?.length, 4);
  assert.equal(shapes.match(/stroke="#9db38f"/g)?.length, 1);
  assert.equal(shapes.match(/fill="#1f241b"/g)?.length, 3);
});

test("the favicon takes its ring from the accent and flips the eggs in dark mode", () => {
  const svg = faviconSvg("#3D63A0");
  assert.match(svg, /stroke="#3d63a0"/);
  assert.match(svg, /prefers-color-scheme:dark/);
  assert.equal(svg.match(/class="e"/g)?.length, 3);
  assert.notEqual(faviconSvg("#9db38f"), svg);
});

test("the favicon link is a data URL that decodes back to the SVG", () => {
  const href = faviconHref("#9db38f");
  assert.ok(href.startsWith("data:image/svg+xml,"));
  assert.equal(decodeURIComponent(href.slice("data:image/svg+xml,".length)), faviconSvg("#9db38f"));
});

test("anything but a 6-digit hex colour is refused, so no markup can slip into the SVG", () => {
  for (const bad of ['red', '#fff', '#9db38f"/><script>', 'url(#x)', ""]) {
    assert.throws(() => faviconSvg(bad));
    assert.throws(() => logoSvg(bad, "#000000"));
    assert.throws(() => appIconSvg(bad));
  }
});

test("the app icon draws the mark on an accent tile", () => {
  const svg = appIconSvg("#9db38f");
  assert.match(svg, /<rect[^>]*fill="#9db38f"/);
  assert.equal(svg.match(/<circle/g)?.length, 4);
});

test("setFavicon repoints the page icon when the accent changes", async () => {
  const { JSDOM } = await import("jsdom");
  const { setFavicon } = await import("./favicon.ts");
  const doc = new JSDOM('<!doctype html><head><link rel="icon" href="./favicon.svg" type="image/svg+xml"></head><body></body>').window.document;
  setFavicon("#9db38f", doc);
  const first = doc.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]')!.href;
  assert.match(decodeURIComponent(first), /stroke="#9db38f"/);
  setFavicon("#d97706", doc);
  assert.equal(doc.querySelectorAll('link[rel="icon"][type="image/svg+xml"]').length, 1);
  assert.match(decodeURIComponent(doc.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]')!.href), /stroke="#d97706"/);
  // No icon link yet: one is added.
  const bare = new JSDOM("<!doctype html><head></head><body></body>").window.document;
  setFavicon("#9db38f", bare);
  assert.equal(bare.querySelectorAll('link[rel="icon"]').length, 1);
});
