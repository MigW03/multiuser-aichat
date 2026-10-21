import assert from "node:assert/strict";
import { test } from "node:test";
import { safeAvatarUrl } from "./avatar.ts";

test("a Google profile picture link passes", () => {
  const url = "https://lh3.googleusercontent.com/a/ACg8ocJ-abc_DEF123=s96-c";
  assert.equal(safeAvatarUrl(url), url);
});

test("anything else is dropped", () => {
  for (const bad of [
    null,
    undefined,
    "",
    "http://lh3.googleusercontent.com/a/x",
    "https://evil.example/a/x",
    "https://lh3.googleusercontent.com.evil.example/a/x",
    "https://lh3.googleusercontent.com@evil.example/a/x",
    "https://lh3.googleusercontent.com/a/x y",
    'https://lh3.googleusercontent.com/a/x"onerror="x',
    "javascript:alert(1)",
    "https://lh3.googleusercontent.com/" + "a".repeat(500),
  ]) {
    assert.equal(safeAvatarUrl(bad), null, String(bad));
  }
});
