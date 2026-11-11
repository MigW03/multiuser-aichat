import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { designMarker, parseDesignMarker, IMAGE_ONLY_TEXT, LIMITS } from "@mc/shared";
import { decideEdit, markerPrefix, type EditTarget } from "./message-edit.ts";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const msg = (over: Partial<EditTarget> = {}): EditTarget => ({ id: "m1", chat_id: "c1", author_id: ME, role: "user", kind: "message", status: "done", content: "hello", run_id: "r1", images: [], ...over });
const answered = { id: "a1", status: "done" as const };
const rejected = (d: ReturnType<typeof decideEdit>) => (d.ok ? null : { status: d.status, error: d.error });

describe("who may edit", () => {
  test("the author edits their own finished message", () => {
    const d = decideEdit(msg(), ME, " hi there ", false, null, true);
    assert.deepEqual(d, { ok: true, content: "hi there", changed: true, regenerate: false });
  });
  test("someone else's message is refused", () => {
    assert.equal(rejected(decideEdit(msg(), OTHER, "x", false, null, true))?.status, 403);
  });
  test("an AI answer is refused, even for the person it was made for", () => {
    assert.equal(rejected(decideEdit(msg({ author_id: null, role: "assistant" }), ME, "x", false, null, true))?.status, 403);
    assert.equal(rejected(decideEdit(msg({ author_id: ME, role: "assistant" }), ME, "x", false, null, true))?.status, 403);
  });
  test("a summary request is refused", () => {
    assert.equal(rejected(decideEdit(msg({ kind: "summary_request" }), ME, "x", false, null, true))?.status, 403);
  });
  test("a missing message is a 404", () => {
    assert.equal(rejected(decideEdit(null, ME, "x", false, null, true))?.status, 404);
  });
  test("a message the AI is still working on waits", () => {
    for (const status of ["pending", "processing", "streaming"] as const) assert.equal(rejected(decideEdit(msg({ status }), ME, "x", false, null, true))?.status, 409, status);
  });
  test("a message that was not answered (error) can be edited", () => {
    assert.equal(decideEdit(msg({ status: "error" }), ME, "x", false, null, true).ok, true);
  });
});

describe("the new words", () => {
  test("empty text is refused", () => {
    assert.equal(rejected(decideEdit(msg(), ME, "  \n ", false, null, true))?.status, 400);
  });
  test("a picture message may lose its words and keeps the placeholder", () => {
    const d = decideEdit(msg({ images: ["p1"], content: "look" }), ME, "", false, null, true);
    assert.deepEqual(d, { ok: true, content: IMAGE_ONLY_TEXT, changed: true, regenerate: false });
  });
  test("an unchanged text is not an edit", () => {
    const d = decideEdit(msg(), ME, "hello", false, null, true);
    assert.equal(d.ok && d.changed, false);
  });
  test("a design marker is kept as it was", () => {
    const marker = designMarker({ names: "Hero title", action: "new" });
    const marked = `${marker}\nmake it bigger`;
    assert.ok(markerPrefix(marked).startsWith("⟦design"));
    const d = decideEdit(msg({ content: marked }), ME, "make it smaller", false, null, true);
    assert.equal(d.ok && d.content, `${markerPrefix(marked)}make it smaller`);
    assert.equal(d.ok && parseDesignMarker(d.content)?.rest, "make it smaller");
    assert.equal(markerPrefix("no marker"), "");
  });
  test("a marker can't be added by an edit to a message that had none", () => {
    const d = decideEdit(msg(), ME, "plain", false, null, true);
    assert.equal(d.ok && d.content, "plain");
  });
  test("more than the limit is refused", () => {
    assert.equal(rejected(decideEdit(msg(), ME, "a".repeat(LIMITS.messageChars + 1), false, null, true))?.status, 400);
  });
});

describe("regenerate", () => {
  test("needs an AI reply to replace", () => {
    assert.equal(rejected(decideEdit(msg(), ME, "x", true, null, true))?.status, 400);
  });
  test("waits for a reply that is still being written", () => {
    assert.equal(rejected(decideEdit(msg(), ME, "x", true, { id: "a1", status: "streaming" }, true))?.status, 409);
  });
  test("needs an AI key", () => {
    assert.equal(rejected(decideEdit(msg(), ME, "x", true, answered, false))?.status, 400);
  });
  test("goes ahead with a finished reply and a key", () => {
    assert.deepEqual(decideEdit(msg(), ME, "x", true, answered, true), { ok: true, content: "x", changed: true, regenerate: true });
  });
  test("someone else can't regenerate your message either", () => {
    assert.equal(rejected(decideEdit(msg(), OTHER, "x", true, answered, true))?.status, 403);
  });
});
