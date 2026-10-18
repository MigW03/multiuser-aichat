import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDeepLink } from "./deeplink.ts";

const AUTH = "multiuserchat://auth#access_token=a.b.c&refresh_token=r&expires_in=3600&token_type=bearer&type=signup";

test("auth link keeps only Supabase's fields and asks for a reload", () => {
  const link = parseDeepLink(`${AUTH}&evil=1&provider_token=x`);
  assert.ok(link?.reload);
  const kept = new URLSearchParams(link.hash.slice(1));
  assert.equal(kept.get("access_token"), "a.b.c");
  assert.equal(kept.get("evil"), null);
  assert.equal(kept.get("provider_token"), null);
});

test("recovery and error links pass", () => {
  assert.ok(parseDeepLink("multiuserchat://auth#access_token=a&refresh_token=r&type=recovery"));
  assert.ok(parseDeepLink("multiuserchat://auth#error=access_denied&error_code=otp_expired&error_description=Link+expired"));
});

test("auth link without tokens, without refresh token, or with an unknown type is refused", () => {
  assert.equal(parseDeepLink("multiuserchat://auth"), null);
  assert.equal(parseDeepLink("multiuserchat://auth#type=signup"), null);
  assert.equal(parseDeepLink("multiuserchat://auth#access_token=a&type=signup"), null);
  assert.equal(parseDeepLink("multiuserchat://auth#access_token=a&refresh_token=r&type=admin"), null);
});

test("open links only carry a route hash", () => {
  const id = "11111111-1111-1111-1111-111111111111";
  assert.deepEqual(parseDeepLink(`multiuserchat://open#/p/${id}/c/${id}`), { hash: `#/p/${id}/c/${id}`, reload: false });
  assert.equal(parseDeepLink("multiuserchat://open#/p/<script>"), null);
  assert.equal(parseDeepLink("multiuserchat://open#javascript:alert(1)"), null);
  assert.equal(parseDeepLink(`multiuserchat://open#/${"a".repeat(300)}`), null);
});

test("other schemes, hosts, junk and huge input are refused", () => {
  assert.equal(parseDeepLink("https://example.com/#access_token=a&refresh_token=r"), null);
  assert.equal(parseDeepLink("multiuserchat://shell#/x"), null);
  assert.equal(parseDeepLink("not a url"), null);
  assert.equal(parseDeepLink(`${AUTH}&x=${"a".repeat(5000)}`), null);
});
