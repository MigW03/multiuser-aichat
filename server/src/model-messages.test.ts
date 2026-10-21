import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newestPictureIds, toModelMessages, transcriptText, type Row } from "./model-messages.ts";

let seq = 0;
const row = (over: Partial<Row>): Row => ({
  id: `m${++seq}`,
  role: "user",
  author_id: "ben",
  kind: "message",
  content: "hello",
  mentions: [],
  reply_to: null,
  skip_reason: null,
  meta: {},
  created_at: "2026-10-20T10:00:00Z",
  seq,
  images: [],
  ...over,
});
const names = new Map([["ben", "Ben"]]);
const png = { data: Uint8Array.of(1, 2, 3), mediaType: "image/png" };

describe("newestPictureIds", () => {
  it("takes the newest pictures first, up to the limit, and ignores the AI's rows", () => {
    const rows = [row({ images: ["a", "b"] }), row({ role: "assistant", images: ["x"] }), row({ images: ["c", "d", "e"] })];
    assert.deepEqual(newestPictureIds(rows, 4), ["e", "d", "c", "b"]);
    assert.deepEqual(newestPictureIds(rows, 1), ["e"]);
  });
});

describe("toModelMessages with pictures", () => {
  it("keeps plain text messages as plain strings", () => {
    const out = toModelMessages([row({ content: "hi" })], names);
    assert.deepEqual(out, [{ role: "user", content: "[Ben]: hi" }]);
  });
  it("sends the pictures it has as file parts after the text", () => {
    const out = toModelMessages([row({ content: "what is this?", images: ["a"] })], names, new Map([["a", png]]));
    assert.equal(out.length, 1);
    const content = out[0]!.content as { type: string; mediaType?: string; text?: string }[];
    assert.equal(content[0]!.type, "text");
    assert.equal(content[0]!.text, "[Ben]: what is this?");
    assert.equal(content[1]!.type, "file");
    assert.equal(content[1]!.mediaType, "image/png");
  });
  it("says so for pictures the AI does not get, and never sends them", () => {
    const out = toModelMessages([row({ content: "old one", images: ["gone", "gone2"] })], names, new Map());
    assert.deepEqual(out, [{ role: "user", content: "[Ben]: old one [2 pictures not shown]" }]);
  });
  it("merges a run of user messages into one turn, pictures included", () => {
    const out = toModelMessages([row({ content: "first", images: ["a"] }), row({ content: "second" })], names, new Map([["a", png]]));
    assert.equal(out.length, 1);
    const parts = out[0]!.content as { type: string; text?: string }[];
    assert.deepEqual(parts.map((p) => p.type), ["text", "file", "text"]);
    assert.equal(parts[2]!.text, "\n\n[Ben]: second");
  });
});

describe("transcriptText", () => {
  it("counts pictures instead of including them", () => {
    assert.match(transcriptText([row({ content: "look", images: ["a", "b"] })], names), /Ben: look \[2 pictures attached\]$/);
  });
});
