import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { findPreviewUrls, parsePreviewUrl, previewLabel, previewPort } from "@mc/shared";
import { cleanBounds, portOpen } from "./preview-util.ts";

test("localhost addresses are accepted and made whole", () => {
  assert.equal(parsePreviewUrl("5173"), "http://localhost:5173/");
  assert.equal(parsePreviewUrl("localhost:3000"), "http://localhost:3000/");
  assert.equal(parsePreviewUrl("  http://127.0.0.1:8080/app?x=1#top "), "http://127.0.0.1:8080/app?x=1#top");
  assert.equal(parsePreviewUrl("http://[::1]:4173"), "http://[::1]:4173/");
  assert.equal(parsePreviewUrl("https://localhost:3443/"), "https://localhost:3443/");
  assert.equal(parsePreviewUrl("LOCALHOST"), "http://localhost/");
});

test("anything that is not localhost is refused", () => {
  for (const bad of [
    "https://example.com",
    "http://localhost.evil.com",
    "http://evil.com/localhost",
    "http://localhost@evil.com",
    "http://user:pw@localhost:3000",
    "http://127.0.0.2:3000",
    "http://192.168.1.5:3000",
    "http://0.0.0.0:3000",
    "http://localhost:99999",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hi",
    "ftp://localhost",
    "http://local host",
    "",
    "   ",
    "70000",
  ]) {
    assert.equal(parsePreviewUrl(bad), null, bad);
  }
  assert.equal(parsePreviewUrl(undefined), null);
  assert.equal(parsePreviewUrl(5173), null);
  assert.equal(parsePreviewUrl(`http://localhost/${"a".repeat(3000)}`), null);
});

test("port and label", () => {
  assert.equal(previewPort("localhost:5173"), 5173);
  assert.equal(previewPort("http://localhost"), 80);
  assert.equal(previewPort("https://localhost"), 443);
  assert.equal(previewPort("https://example.com"), null);
  assert.equal(previewLabel("http://localhost:5173/"), "localhost:5173");
  assert.equal(previewLabel("http://localhost:5173/a?b=1"), "localhost:5173/a?b=1");
  assert.equal(previewLabel("https://localhost:3443/"), "https://localhost:3443");
});

test("localhost addresses are found in text, once each", () => {
  const text = "Open http://localhost:5173/, then http://localhost:5173 again, or (http://127.0.0.1:3000/admin). Not https://example.com or http://localhost.evil.com:80.";
  assert.deepEqual(findPreviewUrls(text), ["http://localhost:5173/", "http://127.0.0.1:3000/admin"]);
  assert.deepEqual(findPreviewUrls("nothing here"), []);
  assert.equal(findPreviewUrls("a http://localhost:1 b http://localhost:2 c http://localhost:3 d http://localhost:4").length, 3);
});

test("rectangles from the page are cleaned", () => {
  assert.deepEqual(cleanBounds({ x: 10.4, y: 20.6, width: 300, height: 400 }), { x: 10, y: 21, width: 300, height: 400 });
  assert.deepEqual(cleanBounds({ x: -5, y: 0, width: 1e9, height: 2 }), { x: 0, y: 0, width: 20000, height: 2 });
  assert.equal(cleanBounds({ x: 1, y: 1, width: NaN, height: 1 }), null);
  assert.equal(cleanBounds({ x: "1", y: 1, width: 1, height: 1 }), null);
  assert.equal(cleanBounds({ x: 1 }), null);
  assert.equal(cleanBounds(null), null);
  assert.equal(cleanBounds("x"), null);
});

test("a port is open only while something listens", async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  assert.equal(await portOpen(port), true);
  await new Promise<void>((r) => server.close(() => r()));
  assert.equal(await portOpen(port), false);
});
