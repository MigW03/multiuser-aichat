import assert from "node:assert/strict";
import { test } from "node:test";
import { updateAction, updateLine, updateWaiting, type UpdateState } from "./update.ts";

const base: UpdateState = { status: "idle", current: "0.1.0", mode: "auto", auto: true };

test("the next step button follows the state and the install mode", () => {
  assert.equal(updateAction(base), null);
  assert.deepEqual(updateAction({ ...base, status: "ready", version: "0.2.0" }), { label: "Restart to update", run: "install" });
  assert.deepEqual(updateAction({ ...base, status: "available", auto: false }), { label: "Download and install", run: "download" });
  assert.deepEqual(updateAction({ ...base, status: "available", mode: "manual" }), { label: "Download", run: "download" });
  assert.equal(updateAction({ ...base, status: "downloading" }), null);
});

test("an update waits on the person only when ready, or found and not taken by itself", () => {
  assert.equal(updateWaiting(null), false);
  assert.equal(updateWaiting(base), false);
  assert.equal(updateWaiting({ ...base, status: "downloading" }), false);
  assert.equal(updateWaiting({ ...base, status: "ready" }), true);
  assert.equal(updateWaiting({ ...base, status: "available", auto: false }), true);
  assert.equal(updateWaiting({ ...base, status: "available", mode: "manual" }), true);
});

test("one line per state", () => {
  const now = 10 * 60_000;
  assert.equal(updateLine({ ...base, status: "downloading", version: "0.2.0", percent: 62 }), "Downloading 0.2.0… 62%");
  assert.equal(updateLine({ ...base, status: "ready", version: "0.2.0" }), "Nido 0.2.0 is ready.");
  assert.equal(updateLine({ ...base, checkedAt: 8 * 60_000 }, now), "Nido 0.1.0 is the latest. Checked 2 min ago.");
  assert.equal(updateLine({ ...base, checkedAt: now }, now), "Nido 0.1.0 is the latest. Checked just now.");
  assert.equal(updateLine({ ...base, status: "error" }), "Could not check for updates.");
});
