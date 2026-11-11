import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectSummary } from "@mc/shared";
import { pushRecent, RECENT_LIMIT, stepIndex, switcherRows } from "./projectSwitch.ts";

const mk = (id: string, name = id): ProjectSummary => ({ id, name, created_by: "u", created_at: "", my_role: "host", member_count: 1, unread_people: 0, unread_ai: 0 });

describe("pushRecent", () => {
  it("puts the id first without repeats", () => {
    assert.deepEqual(pushRecent(["a", "b", "c"], "b"), ["b", "a", "c"]);
  });
  it("ignores junk and caps the list", () => {
    assert.deepEqual(pushRecent({ x: 1 }, "a"), ["a"]);
    assert.deepEqual(pushRecent(["a", 3, null], "b"), ["b", "a"]);
    assert.equal(pushRecent(Array.from({ length: 50 }, (_, i) => `p${i}`), "new").length, 12);
  });
});

describe("switcherRows", () => {
  const all = ["a", "b", "c", "d"].map((id) => mk(id));
  it("lists the current project first, then recent, then list order", () => {
    assert.deepEqual(switcherRows(all, ["c", "b"], "d", "").map((p) => p.id), ["d", "c", "b", "a"]);
  });
  it("cuts to the limit when not searching", () => {
    const many = Array.from({ length: 20 }, (_, i) => mk(`p${i}`));
    assert.equal(switcherRows(many, [], null, "").length, RECENT_LIMIT);
    assert.equal(switcherRows(many, [], null, "p1").length, 11);
  });
  it("filters by name, ignoring case and spaces around", () => {
    const named = [mk("1", "Transface"), mk("2", "Nido"), mk("3", "Trans")];
    assert.deepEqual(switcherRows(named, [], null, "  TRANS ").map((p) => p.id), ["1", "3"]);
    assert.deepEqual(switcherRows(named, [], null, "zzz"), []);
  });
  it("survives a bad remembered list", () => {
    assert.equal(switcherRows(all, "nope", null, "").length, 4);
    assert.equal(switcherRows(all, [1, null, "b"], null, "")[0]?.id, "b");
  });
});

describe("stepIndex", () => {
  it("wraps and starts from the ends", () => {
    assert.equal(stepIndex(-1, 1, 3), 0);
    assert.equal(stepIndex(-1, -1, 3), 2);
    assert.equal(stepIndex(2, 1, 3), 0);
    assert.equal(stepIndex(0, -1, 3), 2);
    assert.equal(stepIndex(0, 1, 0), -1);
  });
});
