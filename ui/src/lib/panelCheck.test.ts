import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PanelSource } from "@mc/shared";
import { buttonActions, drawable, newInUpdate, outline } from "./panelCheck.ts";

const src = (over: Partial<PanelSource> = {}): PanelSource => ({ id: "prs", label: "Open PRs", server: "github", tool: "list_pull_requests", purpose: "List pull requests", args: {}, ...over });

describe("which wireframes the app can draw", () => {
  test("a real panel can be drawn", () => {
    assert.equal(drawable(`root = Stack([SourceStat("Open PRs", "prs", "length"), Check("plan", "Plan today"), Notes("n", "Notes")])`), true);
  });
  test("a part Nido does not have, junk, or nothing, cannot", () => {
    assert.equal(drawable(`root = Stack([Iframe("https://evil.example")])`), false);
    assert.equal(drawable(`root = Stack([Script("alert(1)")])`), false);
    assert.equal(drawable("this is not a program"), false);
    assert.equal(drawable(""), false);
    assert.equal(drawable(`root = Stack([`), false);
  });
});

describe("the outline of a wireframe", () => {
  const view = `root = Stack([stats, todo, notes])
stats = Stack([SourceStat("Open PRs", "prs", "length")], "row")
todo = Card("Today", [Check("plan", "Plan today"), SourceList("prs", "items", "title")])
notes = Notes("notes", "My notes")`;
  test("short lines naming each part, with data blocks named after their source", () => {
    assert.deepEqual(outline(view, [src()]), ["Number · Open PRs", "Section · Today", "Tick · Plan today", "List · Open PRs", "Notes · My notes"]);
  });
  test("no code leaks into it, and it is bounded", () => {
    const many = Array.from({ length: 100 }, (_, i) => `Check("c${i}", "Item ${i}")`).join(", ");
    assert.equal(outline(`root = Stack([${many}])`, []).length, 40);
    assert.deepEqual(outline(`root = Stack([Script("alert(1)")])`, []), []);
  });
});

describe("what an update adds that the person has not agreed to", () => {
  const now = { sources: [src(), src({ id: "jira", label: "Blocked", server: "jira", tool: "search_issues", purpose: "Search issues" })], functions: [{ id: "plan", label: "Plan today" }, { id: "notes", label: "Notes" }] };
  test("a new source and a new function are named; what was there is not", () => {
    const out = newInUpdate({ sources: [src()], functions: [{ id: "plan", label: "Plan today" }] }, now);
    assert.deepEqual(out, ["New: reads Blocked from jira (Search issues)", "New: Notes"]);
  });
  test("the same source reading something else counts as new", () => {
    assert.equal(newInUpdate({ sources: [src({ tool: "list_issues" })], functions: [] }, { sources: [src()], functions: [] }).length, 1);
    assert.equal(newInUpdate({ sources: [src({ args: { state: "open" } })], functions: [] }, { sources: [src({ args: { state: "closed" } })], functions: [] }).length, 1);
    assert.equal(newInUpdate({ sources: [src()], functions: [] }, { sources: [src()], functions: [] }).length, 0);
  });
});

describe("what the buttons really do", () => {
  test("links, copies and drafted messages are read from the program, in the program's words", () => {
    const view = `root = Stack([Buttons([Button("Docs", @OpenUrl("https://evil.example/login")), Button("Copy", @CopyText("rm -rf /")), Button("Ask", @ToAssistant("Draft my standup")), Button("Plain")])])`;
    assert.deepEqual(buttonActions(view), ["Opens the link: https://evil.example/login", "Copies: rm -rf /", "Drafts the message: Draft my standup"]);
  });
  test("a target worked out inside the panel is said so, and the list is bounded", () => {
    assert.deepEqual(buttonActions(`Button("x", @OpenUrl($u))`), ["Opens the link (text worked out inside the panel)"]);
    const many = Array.from({ length: 30 }, (_, i) => `@OpenUrl("https://a.example/${i}")`).join(" ");
    assert.equal(buttonActions(many).length, 12);
    assert.deepEqual(buttonActions("no actions here"), []);
  });
});
