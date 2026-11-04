import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { eraseThisComputer } from "./erase.ts";

describe("erasing this computer's data", () => {
  test("cancelling in the app's window does nothing else: no sign-out, no erase", async () => {
    const calls: string[] = [];
    const done = await eraseThisComputer({ confirm: async () => (calls.push("confirm"), false), run: async () => (calls.push("run"), true) }, async () => void calls.push("signout"));
    assert.equal(done, false);
    assert.deepEqual(calls, ["confirm"]);
  });
  test("after a yes: sign out first, then erase", async () => {
    const calls: string[] = [];
    const done = await eraseThisComputer({ confirm: async () => (calls.push("confirm"), true), run: async () => (calls.push("run"), true) }, async () => void calls.push("signout"));
    assert.equal(done, true);
    assert.deepEqual(calls, ["confirm", "signout", "run"]);
  });
  test("a sign-out that fails (offline) still erases: the data folder goes either way", async () => {
    const calls: string[] = [];
    const done = await eraseThisComputer({ confirm: async () => true, run: async () => (calls.push("run"), true) }, async () => Promise.reject(new Error("offline")));
    assert.equal(done, true);
    assert.deepEqual(calls, ["run"]);
  });
  test("when the app refuses to go ahead, that is what the caller hears", async () => {
    assert.equal(await eraseThisComputer({ confirm: async () => true, run: async () => false }, async () => undefined), false);
  });
});
