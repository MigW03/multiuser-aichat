import { PANEL_LIMITS as L } from "@mc/shared";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { checkDraft, checkState, PanelError, PanelStore } from "./panels-store.ts";

const posix = process.platform !== "win32";
const U = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const P = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let root = "";
let store: PanelStore;
let n = 0;
before(() => {
  root = mkdtempSync(join(tmpdir(), "mc-panels-"));
  store = new PanelStore(join(root, "panels"));
});
const fresh = () => {
  const s = new PanelStore(join(root, `panels-${++n}`));
  return s;
};
const draft = (over: Record<string, unknown> = {}) => ({
  name: "Standup",
  icon: "list",
  view: 'root = Stack([Text("hello")])',
  sources: [{ id: "prs", label: "Open PRs", server: "github", tool: "list_pull_requests", purpose: "List pull requests", args: { state: "open" } }],
  functions: [{ id: "plan", label: "Plan today", kind: "checklist", description: "Ticks saved on this computer." }],
  ...over,
});
const refused = async (job: Promise<unknown>, code: string) => {
  await assert.rejects(job, (e: unknown) => e instanceof PanelError && e.code === code, `expected ${code}`);
};

describe("checking a draft", () => {
  test("a good draft passes and only known fields are kept", () => {
    const d = checkDraft({ ...draft(), extra: "x" });
    assert.deepEqual(Object.keys(d).sort(), ["functions", "icon", "name", "sources", "view"]);
  });
  test("names: trimmed, length, control and invisible characters", () => {
    assert.equal(checkDraft(draft({ name: "  Standup  " })).name, "Standup");
    for (const name of ["", "   ", "x".repeat(L.nameChars + 1), "a\nb", "a\u202eb", "a\u200bb", 5, null]) assert.throws(() => checkDraft(draft({ name })), PanelError, JSON.stringify(name));
  });
  test("icons come from the list", () => {
    for (const icon of ["../x", "skull", "", 1]) assert.throws(() => checkDraft(draft({ icon })), PanelError);
  });
  test("the wireframe: text, not empty, no NUL, under the cap", () => {
    for (const view of ["", "  ", "a\u0000b", 5, undefined]) assert.throws(() => checkDraft(draft({ view })), PanelError);
    assert.throws(() => checkDraft(draft({ view: "x".repeat(L.viewBytes + 1) })), PanelError);
    assert.throws(() => checkDraft(draft({ view: "é".repeat(L.viewBytes / 2 + 1) })), PanelError); // bytes, not characters
    assert.doesNotThrow(() => checkDraft(draft({ view: "x".repeat(L.viewBytes) })));
  });
  test("sources: ids, server and tool names, count, duplicates", () => {
    const src = (o: Record<string, unknown>) => ({ id: "a", label: "L", server: "github", tool: "list", purpose: "P", ...o });
    assert.throws(() => checkDraft(draft({ sources: [src({ id: "a b" })] })), PanelError);
    assert.throws(() => checkDraft(draft({ sources: [src({ server: "../x" })] })), PanelError);
    assert.throws(() => checkDraft(draft({ sources: [src({ tool: "a b" })] })), PanelError);
    assert.throws(() => checkDraft(draft({ sources: [src({}), src({})] })), PanelError);
    assert.throws(() => checkDraft(draft({ sources: Array.from({ length: L.sources + 1 }, (_, i) => src({ id: `s${i}` })) })), PanelError);
    assert.throws(() => checkDraft(draft({ sources: "x" })), PanelError);
    assert.deepEqual(checkDraft(draft({ sources: undefined })).sources, []);
  });
  test("sources: only reads, arguments are plain data", () => {
    const src = (o: Record<string, unknown>) => ({ id: "a", label: "L", server: "github", tool: "list_issues", purpose: "P", ...o });
    for (const tool of ["delete_project", "execute_sql", "create_issue", "get_or_create_user", "list_and_delete_all", "run", "merge_pull_request"]) assert.throws(() => checkDraft(draft({ sources: [src({ tool })] })), PanelError, tool);
    for (const tool of ["list_pull_requests", "get_project", "search_issues", "list_deployments", "get_runtime_logs"]) assert.doesNotThrow(() => checkDraft(draft({ sources: [src({ tool })] })), tool);
    assert.deepEqual(checkDraft(draft({ sources: [src({})] })).sources[0]!.args, {});
    assert.deepEqual(checkDraft(draft({ sources: [src({ args: { state: "open", n: 3, tags: ["a"] } })] })).sources[0]!.args, { state: "open", n: 3, tags: ["a"] });
    for (const args of [[1], "x", null, { a: "x".repeat(L.argChars) }, JSON.parse('{"__proto__": {"x": 1}}'), JSON.parse('{"a": {"constructor": 1}}')]) assert.throws(() => checkDraft(draft({ sources: [src({ args })] })), PanelError, JSON.stringify(args));
  });
  test("the wireframe can't make tool calls of its own", () => {
    for (const view of ['x = Query("list_pull_requests", {})', 'y = Mutation ("delete", {})']) assert.throws(() => checkDraft(draft({ view })), PanelError);
  });
  test("functions: only kinds Nido has", () => {
    const fn = (o: Record<string, unknown>) => ({ id: "f", label: "L", kind: "checklist", description: "D", ...o });
    assert.throws(() => checkDraft(draft({ functions: [fn({ kind: "run_script" })] })), PanelError);
    assert.throws(() => checkDraft(draft({ functions: [fn({}), fn({})] })), PanelError);
    for (const kind of ["checklist", "notes", "input", "draft", "refresh"]) assert.doesNotThrow(() => checkDraft(draft({ functions: [fn({ kind })] })));
  });
});

describe("checking saved data", () => {
  test("plain values pass", () => assert.doesNotThrow(() => checkState({ ticks: { plan: true }, notes: "hi", count: 3, list: [1, "a", null], $notes: "variable" })));
  test("odd keys, odd values, depth, size and count are refused", () => {
    assert.throws(() => checkState(JSON.parse('{"__proto__": 1}')), PanelError);
    assert.throws(() => checkState(JSON.parse('{"a": {"__proto__": 1}}')), PanelError);
    assert.throws(() => checkState({ constructor: 1 }), PanelError);
    assert.throws(() => checkState({ "a b": 1 }), PanelError);
    assert.throws(() => checkState({ "": 1 }), PanelError);
    assert.throws(() => checkState([1]), PanelError);
    assert.throws(() => checkState(null), PanelError);
    assert.throws(() => checkState({ a: undefined }), PanelError);
    assert.throws(() => checkState({ a: () => 1 }), PanelError);
    assert.throws(() => checkState({ a: Infinity }), PanelError);
    assert.throws(() => checkState({ a: new Date() }), PanelError);
    assert.throws(() => checkState({ a: new Map() }), PanelError);
    assert.throws(() => checkState({ a: [[[[[[[1]]]]]]] }), PanelError);
    assert.throws(() => checkState({ a: "x".repeat(L.stateBytes + 1) }), PanelError);
    assert.throws(() => checkState(Object.fromEntries(Array.from({ length: L.stateKeys + 1 }, (_, i) => [`k${i}`, 1]))), PanelError);
  });
});

describe("panels on disk", () => {
  test("create, list, get", async () => {
    const s = fresh();
    const meta = await s.create(U, P, draft());
    assert.equal(meta.rev, 1);
    assert.equal(meta.name, "Standup");
    const list = await s.list(U, P);
    assert.equal(list.length, 1);
    const full = await s.get(U, P, meta.id);
    assert.equal(full.view, draft().view);
    assert.deepEqual(full.state, {});
    assert.equal(full.hasPrev, false);
    assert.deepEqual(full.meta.sources, draft().sources);
  });
  test("nothing for an empty project or another person or another project", async () => {
    const s = fresh();
    const a = await s.create(U, P, draft());
    assert.deepEqual(await s.list(U, P2), []);
    assert.deepEqual(await s.list(U2, P), []);
    await refused(s.get(U2, P, a.id), "not_found");
    await refused(s.get(U, P2, a.id), "not_found");
    await refused(s.delete(U2, P, a.id), "not_found");
    await refused(s.saveState(U2, P, a.id, {}), "not_found");
    assert.equal((await s.list(U, P)).length, 1);
  });
  test("ids that are not UUIDs are refused before any path is built", async () => {
    const s = fresh();
    for (const bad of ["../x", "..", "a/b", "a\\b", "", "x", "11111111-1111-4111-8111-11111111111/", "11111111-1111-4111-8111-111111111111/../a"]) {
      await refused(s.list(bad, P), "bad_request");
      await refused(s.list(U, bad), "bad_request");
      await refused(s.get(U, P, bad), "bad_request");
      await refused(s.delete(U, P, bad), "bad_request");
    }
    await refused(s.create("../x", P, draft()), "bad_request");
  });
  test("files are laid out as documented, owner-only", async () => {
    const s = fresh();
    const dir = join(root, `panels-${n}`);
    const m = await s.create(U, P, draft());
    const pdir = join(dir, U, P, m.id);
    assert.deepEqual(readdirSync(pdir).sort(), ["panel.json", "state.json", "view.openui"]);
    assert.equal(readFileSync(join(pdir, "view.openui"), "utf8"), draft().view);
    if (posix) assert.equal(statSync(join(pdir, "panel.json")).mode & 0o777, 0o600);
    assert.equal(readdirSync(pdir).some((f) => f.endsWith(".tmp")), false);
  });
  test("panel count and names", async () => {
    const s = fresh();
    for (let i = 0; i < L.perProject; i++) await s.create(U, P, draft({ name: `Panel ${i}` }));
    await refused(s.create(U, P, draft({ name: "One more" })), "too_many");
    await s.create(U, P2, draft({ name: "Other project is fine" }));
    const s2 = fresh();
    await s2.create(U, P, draft({ name: "Standup" }));
    await refused(s2.create(U, P, draft({ name: "standup" })), "name_taken");
  });
  test("update keeps one older version and the saved data; undo goes back once", async () => {
    const s = fresh();
    const m = await s.create(U, P, draft());
    await s.saveState(U, P, m.id, { ticks: { plan: true } });
    const v2 = await s.update(U, P, m.id, draft({ name: "Standup 2", view: "v2" }));
    assert.equal(v2.rev, 2);
    let full = await s.get(U, P, m.id);
    assert.equal(full.view, "v2");
    assert.deepEqual(full.state, { ticks: { plan: true } });
    assert.equal(full.hasPrev, true);
    await s.saveState(U, P, m.id, { ticks: { plan: false }, notes: "n" });
    const back = await s.undo(U, P, m.id);
    assert.equal(back.name, "Standup");
    full = await s.get(U, P, m.id);
    assert.equal(full.view, draft().view);
    assert.deepEqual(full.state, { ticks: { plan: true } }); // the data of that version
    assert.equal(full.hasPrev, false);
    await refused(s.undo(U, P, m.id), "no_prev");
  });
  test("a second update replaces the older version", async () => {
    const s = fresh();
    const m = await s.create(U, P, draft());
    await s.update(U, P, m.id, draft({ view: "v2" }));
    await s.update(U, P, m.id, draft({ view: "v3" }));
    await s.undo(U, P, m.id);
    assert.equal((await s.get(U, P, m.id)).view, "v2");
    await refused(s.undo(U, P, m.id), "no_prev");
  });
  test("an update cannot take another panel's name", async () => {
    const s = fresh();
    await s.create(U, P, draft({ name: "A" }));
    const b = await s.create(U, P, draft({ name: "B" }));
    await refused(s.update(U, P, b.id, draft({ name: "a" })), "name_taken");
    await refused(s.rename(U, P, b.id, "A"), "name_taken");
    assert.equal((await s.rename(U, P, b.id, "B")).name, "B");
    assert.equal((await s.rename(U, P, b.id, "C")).name, "C");
  });
  test("rename and icon don't make a new version", async () => {
    const s = fresh();
    const m = await s.create(U, P, draft());
    const r = await s.setIcon(U, P, m.id, "chart");
    assert.equal(r.icon, "chart");
    assert.equal(r.rev, 1);
    assert.equal((await s.get(U, P, m.id)).hasPrev, false);
    await refused(s.setIcon(U, P, m.id, "skull"), "bad_request");
  });
  test("saved data: saved, replaced, cleared, refused when bad, and a bad save leaves the old data", async () => {
    const s = fresh();
    const m = await s.create(U, P, draft());
    await s.saveState(U, P, m.id, { a: 1 });
    await s.saveState(U, P, m.id, { b: 2 });
    assert.deepEqual((await s.get(U, P, m.id)).state, { b: 2 });
    await refused(s.saveState(U, P, m.id, { c: "x".repeat(L.stateBytes + 1) }), "too_big");
    await refused(s.saveState(U, P, m.id, { "bad key": 1 }), "bad_request");
    assert.deepEqual((await s.get(U, P, m.id)).state, { b: 2 });
    await s.clearState(U, P, m.id);
    assert.deepEqual((await s.get(U, P, m.id)).state, {});
    await refused(s.saveState(U, P, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", {}), "not_found");
  });
  test("saves made at once don't corrupt the file", async () => {
    const s = fresh();
    const m = await s.create(U, P, draft());
    await Promise.all(Array.from({ length: 30 }, (_, i) => s.saveState(U, P, m.id, { n: i, pad: "x".repeat(2000) })));
    const st = (await s.get(U, P, m.id)).state as { n: number };
    assert.equal(st.n, 29); // in order
  });
  test("order: new panels go last, move swaps, the ends stay", async () => {
    const s = fresh();
    const a = await s.create(U, P, draft({ name: "A" }));
    const b = await s.create(U, P, draft({ name: "B" }));
    const c = await s.create(U, P, draft({ name: "C" }));
    const names = async () => (await s.list(U, P)).map((p) => ("broken" in p ? "?" : p.name)).join("");
    assert.equal(await names(), "ABC");
    await s.move(U, P, c.id, -1);
    assert.equal(await names(), "ACB");
    await s.move(U, P, a.id, -1); // already first
    assert.equal(await names(), "ACB");
    await s.move(U, P, b.id, 1); // already last
    assert.equal(await names(), "ACB");
    await s.move(U, P, a.id, 1);
    assert.equal(await names(), "CAB");
    await refused(s.move(U, P, a.id, 2), "bad_request");
    await refused(s.move(U, P, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", 1), "not_found");
  });
  test("delete removes the folder, the saved data and the older version", async () => {
    const s = fresh();
    const dir = join(root, `panels-${n}`);
    const a = await s.create(U, P, draft({ name: "A" }));
    const b = await s.create(U, P, draft({ name: "B" }));
    await s.update(U, P, a.id, draft({ name: "A", view: "v2" }));
    await s.saveState(U, P, a.id, { secret: "notes" });
    await s.delete(U, P, a.id);
    assert.equal(existsSync(join(dir, U, P, a.id)), false);
    assert.deepEqual((await s.list(U, P)).map((p) => p.id), [b.id]);
    await refused(s.get(U, P, a.id), "not_found");
    await refused(s.delete(U, P, a.id), "not_found");
    await s.create(U, P, draft({ name: "A" })); // the name is free again
  });
});

describe("damaged and planted files", () => {
  const spoil = async (s: PanelStore, file: string, content: string) => {
    const m = await s.create(U, P, draft());
    writeFileSync(join(root, `panels-${n}`, U, P, m.id, file), content);
    return m;
  };
  test("a damaged panel.json is listed as broken and can be deleted", async () => {
    const s = fresh();
    const m = await spoil(s, "panel.json", "{not json");
    assert.deepEqual(await s.list(U, P), [{ id: m.id, broken: true }]);
    await refused(s.get(U, P, m.id), "broken");
    await refused(s.update(U, P, m.id, draft()), "broken");
    await s.delete(U, P, m.id);
    assert.deepEqual(await s.list(U, P), []);
  });
  test("a panel.json with the wrong id, an unknown icon or a bad revision is broken", async () => {
    for (const patch of [{ id: P }, { icon: "../../x" }, { rev: 0 }, { rev: "1" }, { format: 2 }, { name: "a\u202eb" }, { sources: [{ id: "a b" }] }]) {
      const s = fresh();
      const m = await s.create(U, P, draft());
      const file = join(root, `panels-${n}`, U, P, m.id, "panel.json");
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
      assert.deepEqual(await s.list(U, P), [{ id: m.id, broken: true }], JSON.stringify(patch));
    }
  });
  test("damaged or oversized view.openui and state.json make get refuse", async () => {
    let s = fresh();
    let m = await spoil(s, "state.json", "[1,2]");
    await refused(s.get(U, P, m.id), "broken");
    s = fresh();
    m = await spoil(s, "state.json", JSON.stringify({ "__proto__x y": 1 }));
    await refused(s.get(U, P, m.id), "broken");
    s = fresh();
    m = await spoil(s, "view.openui", "x".repeat(L.viewBytes + 1));
    await refused(s.get(U, P, m.id), "broken");
    s = fresh();
    m = await spoil(s, "state.json", `{"a":"${"x".repeat(L.stateBytes + 2000)}"}`);
    await refused(s.get(U, P, m.id), "broken");
  });
  test("a missing view.openui is broken", async () => {
    const s = fresh();
    const m = await s.create(U, P, draft());
    const { rmSync } = await import("node:fs");
    rmSync(join(root, `panels-${n}`, U, P, m.id, "view.openui"));
    await refused(s.get(U, P, m.id), "broken");
  });
  test("things in the folder that aren't panels are ignored", async () => {
    const s = fresh();
    const base = join(root, `panels-${n}`, U, P);
    const m = await s.create(U, P, draft());
    mkdirSync(join(base, "not-a-uuid"));
    mkdirSync(join(base, "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")); // the app only makes lowercase ids
    writeFileSync(join(base, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"), "a file, not a folder");
    assert.deepEqual((await s.list(U, P)).map((p) => p.id), [m.id]);
  });
  test("a link planted as a panel folder or as a file is never followed", { skip: !posix }, async () => {
    const s = fresh();
    const base = join(root, `panels-${n}`, U, P);
    const m = await s.create(U, P, draft());
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "panel.json"), "secret");
    const linked = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    symlinkSync(outside, join(base, linked));
    assert.deepEqual((await s.list(U, P)).map((p) => p.id), [m.id]);
    await refused(s.get(U, P, linked), "not_found");
    await refused(s.saveState(U, P, linked, {}), "not_found");
    // a link in place of view.openui
    writeFileSync(join(outside, "view"), "outside text");
    const { rmSync } = await import("node:fs");
    rmSync(join(base, m.id, "view.openui"));
    symlinkSync(join(outside, "view"), join(base, m.id, "view.openui"));
    await refused(s.get(U, P, m.id), "broken");
  });
  test("a leftover index.json naming panels that don't exist is harmless", async () => {
    const s = fresh();
    const base = join(root, `panels-${n}`, U, P);
    const m = await s.create(U, P, draft());
    writeFileSync(join(base, "index.json"), JSON.stringify({ order: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "../x", m.id, 5] }));
    assert.deepEqual((await s.list(U, P)).map((p) => p.id), [m.id]);
    writeFileSync(join(base, "index.json"), "garbage");
    assert.deepEqual((await s.list(U, P)).map((p) => p.id), [m.id]);
  });
});

describe("panels that stand in for one of Nido's own tabs", () => {
  test("only the tabs Nido ships can be named", () => {
    assert.equal(checkDraft(draft({ replaces: "vercel" })).replaces, "vercel");
    assert.equal(checkDraft(draft({ replaces: "supabase" })).replaces, "supabase");
    assert.equal(checkDraft(draft()).replaces, undefined);
    assert.equal("replaces" in checkDraft(draft({ replaces: null })), false);
    for (const bad of ["files", "designs", "Vercel", "", "../x", 5, {}]) assert.throws(() => checkDraft(draft({ replaces: bad })), PanelError, JSON.stringify(bad));
  });
  test("it is kept, shown in the list, carried through an update, and dropped when the update drops it", async () => {
    const s = fresh();
    const m = await s.create(U, P, draft({ name: "Vercel", replaces: "vercel" }));
    assert.equal(m.replaces, "vercel");
    assert.equal(((await s.list(U, P))[0] as { replaces?: string }).replaces, "vercel");
    assert.equal((await s.get(U, P, m.id)).meta.replaces, "vercel");
    const v2 = await s.update(U, P, m.id, draft({ name: "Vercel", view: "v2", replaces: "vercel" }));
    assert.equal(v2.replaces, "vercel");
    const v3 = await s.update(U, P, m.id, draft({ name: "Vercel", view: "v3" }));
    assert.equal(v3.replaces, undefined);
    const back = await s.undo(U, P, m.id);
    assert.equal(back.replaces, "vercel", "undo brings the earlier version back as it was");
  });
  test("one panel at a time stands in for each tab", async () => {
    const s = fresh();
    const a = await s.create(U, P, draft({ name: "Vercel", replaces: "vercel" }));
    await refused(s.create(U, P, draft({ name: "Vercel 2", replaces: "vercel" })), "bad_request");
    await s.create(U, P, draft({ name: "Supabase", replaces: "supabase" })); // another tab is fine
    const other = await s.create(U, P, draft({ name: "Other" }));
    await refused(s.update(U, P, other.id, draft({ name: "Other", replaces: "vercel" })), "bad_request");
    await s.update(U, P, a.id, draft({ name: "Vercel", view: "again", replaces: "vercel" })); // itself is fine
  });
  test("a panel.json with an unknown tab is unreadable, not half-trusted", async () => {
    const s = fresh();
    const m = await s.create(U, P, draft({ replaces: "vercel" }));
    const file = join(root, `panels-${n}`, U, P, m.id, "panel.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), replaces: "files" }));
    assert.deepEqual(await s.list(U, P), [{ id: m.id, broken: true }]);
  });
});
