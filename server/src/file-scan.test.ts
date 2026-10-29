import assert from "node:assert/strict";
import { test } from "node:test";
import { containsSecret } from "./file-scan.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const TOKEN = `ghp_${"a1B2c3".repeat(6)}`;

test("finds a token anywhere in a text file, even across a piece boundary", () => {
  assert.equal(containsSecret(bytes(`x = "${TOKEN}"`)), true);
  const big = "a".repeat(1024 * 1024 - 10) + "\n" + TOKEN + "b".repeat(100);
  assert.equal(containsSecret(bytes(big)), true);
  const key = `-----BEGIN RSA PRIVATE KEY-----\n${"MIIE".repeat(900)}\n-----END RSA PRIVATE KEY-----`;
  assert.equal(containsSecret(bytes("a".repeat(1024 * 1024 - 100) + key)), true);
});

test("leaves ordinary text, accented text and binary files alone", () => {
  assert.equal(containsSecret(bytes("hello wörld — ünïcode 日本語\n".repeat(1000))), false);
  assert.equal(containsSecret(bytes("const k = process.env.OPENAI_API_KEY;")), false);
  assert.equal(containsSecret(new Uint8Array([0, ...bytes(TOKEN)])), false);
  assert.equal(containsSecret(new Uint8Array(0)), false);
});

test("a 25 MB text file is scanned in good time", () => {
  const t = Date.now();
  assert.equal(containsSecret(new Uint8Array(25 * 1024 * 1024).fill(97)), false);
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
});
