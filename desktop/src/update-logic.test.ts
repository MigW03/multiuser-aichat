import assert from "node:assert/strict";
import { test } from "node:test";
import { initialState, installMode, isVersion, reduce, releaseUrl, shouldAutoCheck, shouldAutoDownload } from "./update-logic.ts";

const start = () => initialState("0.1.0", "auto", true, true);

test("install mode: Windows installs itself, an unsigned Mac sends to the download, Linux is off", () => {
  assert.equal(installMode("win32", false), "auto");
  assert.equal(installMode("darwin", false), "manual");
  assert.equal(installMode("darwin", true), "auto");
  assert.equal(installMode("linux", true), "off");
});

test("only well-formed versions make a release address", () => {
  assert.equal(releaseUrl("0.2.0"), "https://github.com/MigW03/multiuser-aichat/releases/tag/v0.2.0");
  assert.equal(releaseUrl("1.0.0-beta.1"), "https://github.com/MigW03/multiuser-aichat/releases/tag/v1.0.0-beta.1");
  for (const bad of ["", "1.2", "../x", "1.2.3/../../x", "1.2.3?x=1", "javascript:alert(1)", "1.2.3 ", 5, null, undefined]) assert.equal(releaseUrl(bad), null, String(bad));
  assert.equal(isVersion("0.1.0"), true);
});

test("a dev run or unsupported platform shows nothing and ignores events", () => {
  assert.equal(initialState("0.1.0", "auto", true, false).status, "unavailable");
  assert.equal(initialState("0.1.0", "off", true, true).status, "unavailable");
  const s = initialState("0.1.0", "auto", true, false);
  assert.equal(reduce(s, { type: "found", version: "0.2.0", at: 1 }), s);
});

test("check, find, download, ready", () => {
  let s = reduce(start(), { type: "checking" });
  assert.equal(s.status, "checking");
  s = reduce(s, { type: "found", version: "0.2.0", at: 5 });
  assert.equal(s.status, "available");
  assert.equal(s.version, "0.2.0");
  assert.equal(s.notesUrl, releaseUrl("0.2.0"));
  s = reduce(s, { type: "downloading", percent: 61.6 });
  assert.deepEqual([s.status, s.percent], ["downloading", 62]);
  s = reduce(s, { type: "downloading", percent: 400 });
  assert.equal(s.percent, 100);
  s = reduce(s, { type: "ready", version: "0.2.0" });
  assert.deepEqual([s.status, s.percent], ["ready", undefined]);
});

test("up to date records when it was checked", () => {
  const s = reduce(reduce(start(), { type: "checking" }), { type: "none", at: 42 });
  assert.deepEqual([s.status, s.checkedAt], ["idle", 42]);
});

test("a later check never undoes a download or a ready update", () => {
  let s = reduce(start(), { type: "found", version: "0.2.0", at: 1 });
  s = reduce(s, { type: "downloading", percent: 10 });
  assert.equal(reduce(s, { type: "checking" }).status, "downloading");
  assert.equal(reduce(s, { type: "none", at: 9 }).status, "downloading");
  assert.equal(reduce(s, { type: "found", version: "0.2.0", at: 9 }).status, "downloading");
  const ready = reduce(s, { type: "ready", version: "0.2.0" });
  assert.equal(reduce(ready, { type: "checking" }).status, "ready");
  assert.equal(reduce(ready, { type: "found", version: "0.2.0", at: 9 }), ready);
  assert.equal(reduce(ready, { type: "none", at: 9 }).status, "ready");
});

test("a bad version from the feed is ignored", () => {
  const s = reduce(start(), { type: "found", version: "../evil", at: 3 });
  assert.equal(s.status, "idle");
  assert.equal(s.version, undefined);
});

test("failures: quiet in the background, shown when asked for", () => {
  const checking = reduce(start(), { type: "checking" });
  assert.equal(reduce(checking, { type: "failed", quiet: true }).status, "idle");
  assert.equal(reduce(checking, { type: "failed", quiet: false }).status, "error");
  const waiting = reduce(reduce(start(), { type: "found", version: "0.2.0", at: 1 }), { type: "checking" });
  assert.equal(reduce(waiting, { type: "failed", quiet: true }).status, "available");
});

test("background checks and downloads follow state and the auto choice", () => {
  assert.equal(shouldAutoCheck(start()), true);
  assert.equal(shouldAutoCheck({ ...start(), status: "downloading" }), false);
  assert.equal(shouldAutoCheck({ ...start(), status: "ready" }), false);
  assert.equal(shouldAutoDownload(start()), true);
  assert.equal(shouldAutoDownload(reduce(start(), { type: "auto", on: false })), false);
  assert.equal(shouldAutoDownload(initialState("0.1.0", "manual", true, true)), false);
});
