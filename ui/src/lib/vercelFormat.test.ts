import assert from "node:assert/strict";
import { test } from "node:test";
import type { VercelDeployment } from "@mc/shared";
import { ago, stateDot, vercelTabDot } from "./vercelFormat.ts";

const NOW = Date.parse("2026-10-22T22:00:00Z");
const dep = (state: string): VercelDeployment => ({ id: "dpl_AAAAAAAAAAAAAAAAAAAA", state, target: "production", branch: "main", sha: "abc1234", message: "m", author: "a", createdAt: null, host: "", inspectorUrl: null });
const overview = (state: string | null) => ({ name: "n", framework: "", node: "", repo: "", production: state ? dep(state) : null, domain: null });

test("how long ago", () => {
  assert.equal(ago("2026-10-22T21:59:30Z", NOW), "just now");
  assert.equal(ago("2026-10-22T21:57:00Z", NOW), "3 min ago");
  assert.equal(ago("2026-10-22T20:00:00Z", NOW), "2 h ago");
  assert.equal(ago("2026-10-18T22:00:00Z", NOW), "4 d ago");
  assert.equal(ago(null, NOW), "");
  assert.equal(ago("nonsense", NOW), "");
});

test("deployment states: ready is green, error red, building yellow, the rest plain", () => {
  assert.equal(stateDot("READY"), "ready");
  assert.equal(stateDot("ERROR"), "failed");
  for (const s of ["BUILDING", "QUEUED", "INITIALIZING"]) assert.equal(stateDot(s), "signin");
  for (const s of ["CANCELED", "BLOCKED", ""]) assert.equal(stateDot(s), "off");
});

test("the dot on the tab: red when production failed, yellow while building, none otherwise", () => {
  assert.equal(vercelTabDot(null), null);
  assert.equal(vercelTabDot(overview(null)), null);
  assert.equal(vercelTabDot(overview("READY")), null);
  assert.equal(vercelTabDot(overview("ERROR")), "failed");
  assert.equal(vercelTabDot(overview("BUILDING")), "signin");
});
