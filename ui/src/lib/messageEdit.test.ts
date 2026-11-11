import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { answerOf, canEditMessage, designMarker, IMAGE_ONLY_TEXT, isRegenerated, lastEditableOf, LIMITS, type ChatMessage } from "@mc/shared";
import { editableWords, editState } from "./messageEdit.ts";

const ME = "u-me";
const BEN = "u-ben";
let n = 0;
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${++n}`,
  chat_id: "c1",
  author_id: ME,
  role: "user",
  kind: "message",
  content: "hello",
  status: "done",
  seq: n,
  created_at: "2026-11-11T10:00:00.000Z",
  provider: null,
  model: null,
  reasoning: null,
  reply_to: null,
  mentions: [],
  skip_reason: null,
  for_user_id: null,
  key_user_id: null,
  run_id: null,
  meta: {},
  images: [],
  edited_at: null,
  ...over,
});

describe("canEditMessage", () => {
  test("only your own finished plain message", () => {
    assert.equal(canEditMessage(msg(), ME), true);
    assert.equal(canEditMessage(msg({ status: "error" }), ME), true);
    assert.equal(canEditMessage(msg({ author_id: BEN }), ME), false, "someone else's");
    assert.equal(canEditMessage(msg({ role: "assistant", author_id: null, for_user_id: ME }), ME), false, "an AI answer");
    assert.equal(canEditMessage(msg({ kind: "summary_request" }), ME), false);
    for (const status of ["pending", "processing", "streaming"] as const) assert.equal(canEditMessage(msg({ status }), ME), false, status);
  });
  test("never when nobody wrote it", () => {
    assert.equal(canEditMessage(msg({ author_id: null }), ME), false);
  });
});

describe("lastEditableOf (Up arrow)", () => {
  test("picks your newest message, skipping other people's", () => {
    const mine = msg({ content: "mine" });
    const all = [msg(), mine, msg({ author_id: BEN })];
    assert.equal(lastEditableOf(all, ME)?.id, mine.id);
  });
  test("does not fall back to an older message when the newest is still being answered", () => {
    const all = [msg(), msg({ status: "processing" })];
    assert.equal(lastEditableOf(all, ME), undefined);
  });
  test("nothing when you wrote nothing", () => {
    assert.equal(lastEditableOf([msg({ author_id: BEN })], ME), undefined);
  });
});

describe("answers and the (regenerated) tag", () => {
  const question = (over: Partial<ChatMessage> = {}) => msg({ run_id: "r1", ...over });
  const answer = (over: Partial<ChatMessage> = {}) => msg({ role: "assistant", author_id: null, for_user_id: ME, run_id: "r1", created_at: "2026-11-11T10:05:00.000Z", ...over });

  test("finds the answer made for this person in the same run", () => {
    const q = question();
    const a = answer();
    const other = answer({ for_user_id: BEN });
    assert.equal(answerOf(q, [q, other, a])?.id, a.id);
    assert.equal(answerOf(msg(), [a]), undefined, "a message with no run has no answer");
  });
  test("tagged when the question was edited before the answer was written", () => {
    const q = question({ edited_at: "2026-11-11T10:04:00.000Z" });
    assert.equal(isRegenerated(answer(), [q]), true);
  });
  test("not tagged when only the words were saved and the old answer stayed", () => {
    const q = question({ edited_at: "2026-11-11T10:09:00.000Z" });
    assert.equal(isRegenerated(answer(), [q]), false);
  });
  test("not tagged when the question was never edited, or belongs to another run", () => {
    assert.equal(isRegenerated(answer(), [question()]), false);
    assert.equal(isRegenerated(answer(), [question({ run_id: "r2", edited_at: "2026-11-11T10:04:00.000Z" })]), false);
  });
  test("a person's message is never tagged", () => {
    assert.equal(isRegenerated(question({ edited_at: "2026-11-11T10:04:00.000Z" }), [question({ edited_at: "2026-11-11T10:04:00.000Z" })]), false);
  });
});

describe("editableWords", () => {
  test("plain text as it is", () => assert.equal(editableWords("hello **there**", 0), "hello **there**"));
  test("a design marker is not part of the words", () => {
    assert.equal(editableWords(`${designMarker({ action: "new" })}\nmake it blue`, 0), "make it blue");
  });
  test("a picture-only message starts with an empty box", () => {
    assert.equal(editableWords(IMAGE_ONLY_TEXT, 1), "");
    assert.equal(editableWords(IMAGE_ONLY_TEXT, 0), IMAGE_ONLY_TEXT, "without pictures it is just text");
  });
});

describe("editState (Save on or off)", () => {
  test("empty text turns Save off", () => {
    assert.equal(editState("   \n", "hello", false).canSave, false);
  });
  test("a message with pictures may lose its words", () => {
    assert.equal(editState("", "look", true).canSave, true);
  });
  test("nothing changed turns Save off", () => {
    assert.equal(editState("hello ", "hello", false).canSave, false);
  });
  test("changed text turns Save on and is trimmed", () => {
    assert.deepEqual(editState("  hello you ", "hello", false), { text: "hello you", canSave: true });
  });
  test("too long turns Save off", () => {
    assert.equal(editState("a".repeat(LIMITS.messageChars + 1), "hello", false).canSave, false);
  });
});
