import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScriptRun, ScriptsInfo } from "@mc/shared";
import { showScriptsTab } from "./scriptsTab.ts";

const script = { key: "k", folder: "app", name: "dev", body: "vite", command: "npm run dev" };
const run: ScriptRun = { key: "k", name: "dev", state: "run", startedAt: 1, endedAt: null, exitCode: null, unseen: false, note: null };
const info = (scripts: ScriptsInfo["scripts"], runs: ScriptRun[] = []): ScriptsInfo => ({ scripts, runs });

test("hidden until the scripts are known", () => {
  assert.equal(showScriptsTab(null), false);
});

test("hidden when the shared folders have no scripts", () => {
  assert.equal(showScriptsTab(info([])), false);
});

test("shown when a shared folder has a script", () => {
  assert.equal(showScriptsTab(info([script])), true);
});

test("shown while a run is left, even if the script is gone from package.json", () => {
  assert.equal(showScriptsTab(info([], [run])), true);
});
