import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { PanelDrafts } from "./panels-drafts.ts";
import { PanelError, PanelStore } from "./panels-store.ts";

const U = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const P = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const draft = (over: Record<string, unknown> = {}) => ({ name: "Standup", icon: "list", view: 'root = Stack([Text("hi")])', sources: [], functions: [], ...over });
const refused = async (job: Promise<unknown> | (() => unknown), code?: string) => {
  await assert.rejects(Promise.resolve().then(() => (typeof job === "function" ? job() : job)), (e: unknown) => e instanceof PanelError && (code === undefined || e.code === code));
};

let root = "";
before(() => {
  root = mkdtempSync(join(tmpdir(), "mc-drafts-"));
});
let n = 0;
function setup() {
  const store = new PanelStore(join(root, `s${++n}`));
  const told: string[] = [];
  let clock = 1_000_000;
  const drafts = new PanelDrafts(store, (u, p) => told.push(`${u}:${p}`), () => clock);
  return { store, drafts, told, tick: (ms: number) => (clock += ms) };
}

describe("a proposal from the AI", () => {
  test("is kept for the person, checked, and nothing is made yet", async () => {
    const { store, drafts, told } = setup();
    const d = await drafts.propose(U, P, undefined, draft());
    assert.equal(d.kind, "new");
    assert.equal(d.name, "Standup");
    assert.deepEqual(await store.list(U, P), [], "nothing was made");
    assert.deepEqual(drafts.list(U, P).map((x) => x.id), [d.id]);
    assert.deepEqual(told, [`${U}:${P}`]);
  });
  test("a bad draft never gets kept", async () => {
    const { drafts } = setup();
    for (const bad of [draft({ name: "" }), draft({ view: 'x = Query("a", {})' }), draft({ icon: "skull" }), null, "x"]) await refused(drafts.propose(U, P, undefined, bad), "bad_request");
    assert.deepEqual(drafts.list(U, P), []);
  });
  test("a new panel can't take the name of one the person has", async () => {
    const { store, drafts } = setup();
    await store.create(U, P, draft());
    await refused(drafts.propose(U, P, undefined, draft({ name: "standup" })), "name_taken");
  });
  test("an update carries what the panel is now, for the before and after", async () => {
    const { store, drafts } = setup();
    const m = await store.create(U, P, draft());
    const d = await drafts.propose(U, P, m.id, draft({ view: 'root = Stack([Text("v2")])' }));
    assert.equal(d.kind, "update");
    assert.equal(d.panelId, m.id);
    assert.equal(d.before!.view, draft().view);
    assert.equal(d.before!.rev, 1);
    await refused(drafts.propose(U, P, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", draft()), "not_found");
  });
  test("the newest proposal for the same panel or name replaces the old; at most five wait", async () => {
    const { store, drafts } = setup();
    const m = await store.create(U, P, draft({ name: "A" }));
    await drafts.propose(U, P, m.id, draft({ name: "A", view: "root = Stack([])" }));
    await drafts.propose(U, P, m.id, draft({ name: "A", view: 'root = Stack([Text("2")])' }));
    assert.equal(drafts.list(U, P).length, 1);
    await drafts.propose(U, P, undefined, draft({ name: "N" }));
    await drafts.propose(U, P, undefined, draft({ name: "n" }));
    assert.equal(drafts.list(U, P).length, 2);
    for (let i = 0; i < 8; i++) await drafts.propose(U, P, undefined, draft({ name: `X${i}` }));
    assert.equal(drafts.list(U, P).length, 5);
    assert.ok(drafts.list(U, P).some((d) => d.name === "X7"), "the newest are kept");
  });
  test("they expire", async () => {
    const { drafts, tick } = setup();
    await drafts.propose(U, P, undefined, draft());
    tick(60 * 60_000);
    assert.equal(drafts.list(U, P).length, 1);
    tick(61 * 60_000);
    assert.equal(drafts.list(U, P).length, 0);
  });
  test("they are the signed-in person's alone", async () => {
    const { drafts } = setup();
    const d = await drafts.propose(U, P, undefined, draft());
    assert.deepEqual(drafts.list(U2, P), []);
    assert.deepEqual(drafts.list(U, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), []);
    await refused(drafts.commit(U2, P, d.id), "not_found");
    await refused(() => drafts.discard(U2, P, d.id), "not_found");
    assert.equal(drafts.list(U, P).length, 1);
  });
});

describe("the person's click", () => {
  test("Add saves exactly the proposal that was kept, once", async () => {
    const { store, drafts } = setup();
    const d = await drafts.propose(U, P, undefined, draft({ name: "Notes", view: 'root = Stack([Notes("n", "Notes")])' }));
    const r = await drafts.commit(U, P, d.id);
    assert.equal(r.kind, "new");
    assert.equal(r.meta.name, "Notes");
    assert.equal((await store.get(U, P, r.meta.id)).view, 'root = Stack([Notes("n", "Notes")])');
    assert.deepEqual(drafts.list(U, P), []);
    await refused(drafts.commit(U, P, d.id), "not_found");
  });
  test("Update makes a new version and keeps the saved data; it refuses if the panel changed meanwhile", async () => {
    const { store, drafts } = setup();
    const m = await store.create(U, P, draft());
    await store.saveState(U, P, m.id, { a: 1 });
    const d = await drafts.propose(U, P, m.id, draft({ view: 'root = Stack([Text("v2")])' }));
    const r = await drafts.commit(U, P, d.id);
    assert.equal(r.meta.rev, 2);
    assert.deepEqual((await store.get(U, P, m.id)).state, { a: 1 });
    const d2 = await drafts.propose(U, P, m.id, draft({ view: 'root = Stack([Text("v3")])' }));
    await store.update(U, P, m.id, draft({ view: 'root = Stack([Text("someone else")])' })); // changed behind the proposal
    await refused(drafts.commit(U, P, d2.id), "bad_request");
    assert.equal((await store.get(U, P, m.id)).view, 'root = Stack([Text("someone else")])');
  });
  test("a delete request deletes nothing and can't be committed; only the app's own Delete does that", async () => {
    const { store, drafts } = setup();
    const m = await store.create(U, P, draft());
    const d = await drafts.proposeDelete(U, P, m.id);
    assert.equal(d.kind, "delete");
    assert.equal(d.name, "Standup");
    await refused(drafts.commit(U, P, d.id), "bad_request");
    assert.equal((await store.list(U, P)).length, 1);
    drafts.forgetPanel(U, P, m.id);
    assert.deepEqual(drafts.list(U, P), []);
    await refused(drafts.proposeDelete(U, P, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"), "not_found");
  });
  test("Not now throws the proposal away; signing out clears the person's", async () => {
    const { drafts } = setup();
    const a = await drafts.propose(U, P, undefined, draft({ name: "A" }));
    drafts.discard(U, P, a.id);
    assert.deepEqual(drafts.list(U, P), []);
    await drafts.propose(U, P, undefined, draft({ name: "B" }));
    await drafts.propose(U2, P, undefined, draft({ name: "C" }));
    drafts.clearUser(U);
    assert.deepEqual(drafts.list(U, P), []);
    assert.equal(drafts.list(U2, P).length, 1);
  });
  test("a full project refuses Add with the reason", async () => {
    const { store, drafts } = setup();
    for (let i = 0; i < 12; i++) await store.create(U, P, draft({ name: `P${i}` }));
    const d = await drafts.propose(U, P, undefined, draft({ name: "One more" }));
    await refused(drafts.commit(U, P, d.id), "too_many");
    assert.equal(drafts.list(U, P).length, 1, "it stays, so the person can delete one and try again");
  });
});

describe("a proposal that stands in for one of Nido's tabs", () => {
  test("keeps that through the card and the click, and an update shows what the panel was", async () => {
    const { store, drafts } = setup();
    const d = await drafts.propose(U, P, undefined, draft({ name: "Vercel", replaces: "vercel" }));
    assert.equal(d.replaces, "vercel");
    const r = await drafts.commit(U, P, d.id);
    assert.equal(r.meta.replaces, "vercel");
    const u = await drafts.propose(U, P, r.meta.id, draft({ name: "Vercel", view: 'root = Stack([Text("v2")])', replaces: "vercel" }));
    assert.equal(u.before!.replaces, "vercel");
    assert.equal((await drafts.commit(U, P, u.id)).meta.replaces, "vercel");
    assert.equal((await store.get(U, P, r.meta.id)).meta.rev, 2);
  });
  test("a second panel for the same tab is refused when the person clicks, with the reason", async () => {
    const { store, drafts } = setup();
    await store.create(U, P, draft({ name: "Vercel", replaces: "vercel" }));
    const d = await drafts.propose(U, P, undefined, draft({ name: "Vercel again", replaces: "vercel" }));
    await refused(drafts.commit(U, P, d.id), "bad_request");
  });
});
