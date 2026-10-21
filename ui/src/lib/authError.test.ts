import assert from "node:assert/strict";
import { test } from "node:test";
import { authErrorMessage, parseAuthError } from "./authError.ts";

test("no error in a normal address", () => {
  assert.equal(parseAuthError("", ""), null);
  assert.equal(parseAuthError("?x=1", "#/p/abc"), null);
  assert.equal(parseAuthError("", "#access_token=a&refresh_token=b"), null);
});

test("reads the error from the fragment or the query", () => {
  assert.equal(parseAuthError("", "#error=access_denied&error_code=otp_expired&error_description=x"), "otp_expired");
  assert.equal(parseAuthError("?error=access_denied&error_description=denied", ""), "access_denied");
  assert.equal(parseAuthError("?error=server_error", "#error=server_error&error_code=unexpected_failure"), "unexpected_failure");
});

test("the code is cut short and lower case, the provider's text is never kept", () => {
  assert.equal(parseAuthError("?error=" + "A".repeat(200), "")?.length, 60);
  assert.equal(parseAuthError("?error=X", ""), "x");
});

test("messages", () => {
  assert.match(authErrorMessage("otp_expired"), /expired/);
  assert.match(authErrorMessage("access_denied"), /cancelled/);
  assert.match(authErrorMessage("unexpected_failure"), /failed/);
});
