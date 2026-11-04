import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "./secrets.ts";
import { logTail, TROUBLESHOOT_CHARS, TROUBLESHOOT_LINES, troubleshootMessage } from "./troubleshoot.ts";

test("keeps only the last lines", () => {
  const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const tail = logTail(log).split("\n");
  assert.equal(tail.length, TROUBLESHOOT_LINES);
  assert.equal(tail.at(-1), "line 499");
});

test("caps the characters", () => {
  assert.ok(logTail("x".repeat(50_000)).length <= TROUBLESHOOT_CHARS);
});

test("removes colour codes", () => {
  assert.equal(logTail("\x1b[31merror\x1b[0m"), "error");
});

test("removes keys, tokens, passwords and env lines", () => {
  const log = "key sk-ant-api03-abcdefghijklmnopqrstuvwx\nghp_" + "a".repeat(36) + "\npassword: hunter2222\nSUPABASE_SERVICE_ROLE_KEY=abc\nexport API_TOKEN = zzz\nplain line";
  const out = redactSecrets(log);
  assert.ok(!/sk-ant|ghp_|hunter|abc$|zzz/m.test(out));
  assert.match(out, /plain line/);
  assert.match(out, /SUPABASE_SERVICE_ROLE_KEY=\[removed\]/);
});

test("the message names the script and the exit code, and cannot close its own code block", () => {
  const m = troubleshootMessage("dev:web", 1, null, "boom ``` end");
  assert.match(m, /`dev:web` crashed with exit code 1/);
  assert.equal(m.match(/```/g)?.length, 2);
});

test("a script that could not start says why; no log says so", () => {
  const m = troubleshootMessage("dev", null, "Commands are off", null);
  assert.match(m, /couldn't start: Commands are off/);
  assert.match(m, /printed nothing/);
});
