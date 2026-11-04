import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { isReadTool, pickPath, readValue, viewIsAllowed } from "@mc/shared";
import { createParser } from "@openuidev/react-lang";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Renderer } from "@openuidev/react-lang";
import { cellText, PanelDataContext, panelLibrary, type PanelData } from "../genui/panel-library.tsx";
import { cleanState } from "./panels.ts";

describe("which tool names count as reads", () => {
  test("reads", () => {
    for (const n of ["list_pull_requests", "get_project", "search_issues", "list_deployments", "get_runtime_logs", "list-tables", "get_status", "describe_table", "get_commit", "list_comments"]) assert.equal(isReadTool(n), true, n);
  });
  test("anything that changes, runs or creates is not", () => {
    for (const n of ["delete_project", "execute_sql", "create_issue", "get_or_create_user", "list_and_delete", "run_query", "merge_pull_request", "update_issue", "send_message", "deploy", "push_files", "set_env", "echo", "", "list x", "list;rm", "a".repeat(65), "get_settings_and_reset"]) assert.equal(isReadTool(n), false, n);
    assert.equal(isReadTool(5), false);
    assert.equal(isReadTool(null), false);
  });
});

describe("paths into what a source returned", () => {
  const data = { total: 7, items: [{ title: "a", n: 1, tags: ["x"] }, { title: "b" }], name: "hello", nested: { deep: { v: true } } };
  test("names, positions, length", () => {
    assert.equal(pickPath(data, "total"), 7);
    assert.equal(pickPath(data, "items.length"), 2);
    assert.equal(pickPath(data, "items.count"), 2);
    assert.equal(pickPath(data, "items[0].title"), "a");
    assert.equal(pickPath(data, "items.1.title"), "b");
    assert.equal(pickPath(data, "items[0].tags[0]"), "x");
    assert.equal(pickPath(data, "name.length"), 5);
    assert.equal(pickPath(data, "nested.deep.v"), true);
    assert.equal(pickPath(data, ""), data);
    assert.equal(pickPath([1, 2], "length"), 2);
    assert.equal(pickPath([{ a: 1 }], "[0].a"), 1);
  });
  test("missing, odd or dangerous paths give undefined and run nothing", () => {
    for (const p of ["nope", "items[5].title", "items.title", "total.x", "__proto__", "constructor", "items.constructor", "a.__proto__.b", "toString", "items.map", "name.toUpperCase", "items[0]x", "a..b", "a b", "a;b", "$x", "x()", "x".repeat(300), "a.b.c.d.e.f.g.h.i"]) assert.equal(pickPath(data, p), undefined, p);
    assert.equal(pickPath(null, "a"), undefined);
    assert.equal(pickPath(undefined, "a"), undefined);
    assert.equal(pickPath(JSON.parse('{"__proto__": 1}'), "__proto__"), undefined);
    assert.equal(pickPath({}, "hasOwnProperty"), undefined);
  });
  test("what a source said: JSON when it is, else the text", () => {
    assert.deepEqual(readValue('{"a":[1]}'), { a: [1] });
    assert.equal(readValue("plain words"), "plain words");
  });
});

describe("what a cell may show", () => {
  test("plain text, numbers, yes/no, cut; nothing else", () => {
    assert.equal(cellText("hi"), "hi");
    assert.equal(cellText(3), "3");
    assert.equal(cellText(true), "yes");
    assert.equal(cellText({ a: 1 }), "");
    assert.equal(cellText(null), "");
    assert.equal(cellText(NaN), "");
    assert.equal(cellText("x".repeat(500)).length, 201);
  });
});

describe("saved state sent to the folder", () => {
  test("undefined and functions are dropped", () => {
    assert.deepEqual(cleanState({ a: 1, b: undefined, c: { d: undefined, e: [1, undefined] } }), { a: 1, c: { e: [1, null] } });
  });
});

describe("the panel library", () => {
  const parser = createParser(panelLibrary.toJSONSchema(), panelLibrary.root);
  const errors = (p: string) => parser.parse(p).meta.errors.filter((e) => e.severity !== "warning").map((e) => `${e.code}: ${e.message}`);

  test("the committed spec matches the library (run `npm run genui:spec -w ui` after changing it)", () => {
    const committed = readFileSync(new URL("../../../shared/src/panel-spec.json", import.meta.url), "utf8");
    assert.equal(committed, `${JSON.stringify(panelLibrary.toSpec(), null, 2)}\n`);
  });

  test("the committed schema matches the library (the server checks drafts with it)", () => {
    const committed = readFileSync(new URL("../../../shared/src/panel-schema.json", import.meta.url), "utf8");
    assert.equal(committed, `${JSON.stringify(panelLibrary.toJSONSchema(), null, 2)}\n`);
  });

  test("a panel as the board draws it parses", () => {
    const program = `root = Stack([stats, todo, notes, drafts])
stats = Stack([SourceStat("Open PRs", "prs", "items.length"), SourceStat("Waiting", "prs", "total", "needs review")], "row")
todo = Card("Today", [Check("plan", "Plan today"), Check("post", "Post update"), SourceList("prs", "items", "title", "author", "Open PRs")])
notes = Notes("notes", "Notes", "Anything to remember")
drafts = Buttons([Button("Draft standup", @ToAssistant("Draft my standup from the open pull requests"))])`;
    assert.deepEqual(errors(program), []);
    assert.ok(parser.parse(program).root);
  });

  test("the table block and chat blocks work in a panel too", () => {
    const program = `root = Stack([SourceTable("prs", "items", [Col("Title", "title"), Col("By", "author")]), Table(["a"], [["b"]]), Stat("x", 1), Input("name", "Name")])`;
    assert.deepEqual(errors(program), []);
  });

  test("the chat library does not know the panel blocks", async () => {
    const { genLibrary } = await import("../genui/library.tsx");
    const chat = createParser(genLibrary.toJSONSchema(), genLibrary.root);
    const r = chat.parse(`root = Stack([SourceStat("x", "prs", "n")])`);
    assert.ok(r.meta.errors.length > 0 || !r.root);
  });

  test("Query and Mutation never reach a panel", () => {
    assert.equal(viewIsAllowed(`x = Query("list_prs", {})`), false);
    assert.equal(viewIsAllowed(`root = Stack([Text("Query is a word")])`), true);
  });

  const draw = (view: string, sources: PanelData["sources"], state?: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(PanelDataContext.Provider, { value: { sources, act: { fix: () => undefined, askToFix: () => undefined } } }, createElement(Renderer, { library: panelLibrary, response: view, initialState: state, onError: () => undefined })),
    );

  const view = `root = Stack([SourceStat("Open PRs", "prs", "items.length"), SourceList("prs", "items", "title"), Check("plan", "Plan today"), Notes("notes", "Notes")])`;

  test("data shows as plain text, counted and listed", () => {
    const html = draw(view, { prs: { label: "Open PRs", status: "ok", value: { items: [{ title: "<script>alert(1)</script> fix" }, { title: "two" }] }, truncated: false } });
    assert.match(html, />2</);
    assert.match(html, /two/);
    assert.ok(!html.includes("<script>"), "text from a service is escaped");
    assert.match(html, /&lt;script&gt;/);
  });

  test("a service that needs sign-in shows an amber card only where it is used; the rest still draws", () => {
    const html = draw(view, { prs: { label: "Open PRs", status: "need", need: "signin", server: "github" } });
    assert.match(html, /Sign in to github/);
    assert.match(html, /gen-need/);
    assert.match(html, /Plan today/);
    assert.match(html, /Notes/);
    assert.ok(!/error|failed/i.test(html.replace(/class="[^"]*"/g, "")), "no error wording");
  });

  test("a block naming a source the panel doesn't have says so by itself", () => {
    const html = draw(`root = Stack([SourceStat("x", "ghost", "n"), Check("plan", "Plan today")])`, {});
    assert.match(html, /couldn&#x27;t be drawn|couldn't be drawn/);
    assert.match(html, /Plan today/);
  });

  test("saved ticks and notes come back", () => {
    const html = draw(`root = Stack([Check("plan", "Plan today"), Notes("notes", "Notes")])`, {}, { plan: { value: true } });
    assert.match(html, /Plan today/);
  });
});
