import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { panelIdOf, panelTab, pickedTab, splitPanelTabs, tabShowsName, type FilesTab } from "./filesTabs.ts";

const ids = ["a", "b", "c", "d", "e"];

describe("which custom panels get a tab", () => {
  test("up to three have their own tab; the rest go behind the menu", () => {
    assert.deepEqual(splitPanelTabs(["a", "b"], null), { shown: ["a", "b"], hidden: [] });
    assert.deepEqual(splitPanelTabs(ids, null), { shown: ["a", "b", "c"], hidden: ["d", "e"] });
    assert.deepEqual(splitPanelTabs([], null), { shown: [], hidden: [] });
  });
  test("the open panel always has its tab, even from behind the menu", () => {
    assert.deepEqual(splitPanelTabs(ids, "e"), { shown: ["a", "b", "e"], hidden: ["c", "d"] });
    assert.deepEqual(splitPanelTabs(ids, "b"), { shown: ["a", "b", "c"], hidden: ["d", "e"] });
    assert.deepEqual(splitPanelTabs(ids, "unknown"), { shown: ["a", "b", "c"], hidden: ["d", "e"] });
  });
  test("twelve panels are all reachable", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const { shown, hidden } = splitPanelTabs(twelve, "p11");
    assert.equal(shown.length + hidden.length, 12);
    assert.ok(shown.includes("p11"));
  });
});

describe("panel tabs in the strip", () => {
  test("a panel tab is a panel: prefixed, and read back", () => {
    assert.equal(panelTab("abc"), "panel:abc");
    assert.equal(panelIdOf(panelTab("abc")), "abc");
    assert.equal(panelIdOf("files"), null);
    assert.equal(panelIdOf("vercel"), null);
  });
  test("only the open panel shows its name", () => {
    const shown: FilesTab[] = ["files", "designs", "panel:a", "panel:b"];
    assert.equal(tabShowsName("panel:a", "panel:a", shown), true);
    assert.equal(tabShowsName("panel:a", "files", shown), false);
    assert.equal(tabShowsName("files", "panel:a", shown), true);
  });
  test("a saved panel choice opens only while that panel exists", () => {
    assert.equal(pickedTab("panel:a", ["files", "designs", "panel:a"]), "panel:a");
    assert.equal(pickedTab("panel:a", ["files", "designs"]), "files");
  });
});
