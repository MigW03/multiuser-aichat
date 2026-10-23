import assert from "node:assert/strict";
import { describe, test } from "node:test";

process.env.SUPABASE_URL ??= "http://localhost:54399";
process.env.SUPABASE_SECRET_KEY ??= "test";
process.env.KEY_ENCRYPTION_SECRET ??= Buffer.alloc(32, 7).toString("base64");
process.env.APP_URL ??= "http://localhost:5173";

import type { Admin } from "./supabase.ts";
import { answerSlot } from "./answer-slot.ts";

type Row = Record<string, unknown>;

/** Just enough of the query builder: one messages table with eq / in filters. Insert gives the next seq, like the identity column. */
function fakeDb(rows: Row[]) {
  let seq = Math.max(0, ...rows.map((r) => Number(r.seq)));
  const table = {
    select: () => query(),
    update: (patch: Row) => query((m) => m.forEach((r) => Object.assign(r, patch))),
    insert: (row: Row) => {
      const r = { id: `new-${rows.length}`, seq: ++seq, ...row };
      rows.push(r);
      return query(undefined, [r]);
    },
  };
  function query(apply?: (m: Row[]) => void, fixed?: Row[]) {
    const filters: ((r: Row) => boolean)[] = [];
    const q = {
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      in: (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k])), q),
      select: () => q,
      maybeSingle: async () => ({ data: pick()[0] ?? null, error: null }),
      single: async () => ({ data: pick()[0] ?? null, error: null }),
    };
    const pick = () => {
      const m = fixed ?? rows.filter((r) => filters.every((f) => f(r)));
      apply?.(m);
      return m;
    };
    return q;
  }
  return { from: () => table } as unknown as Admin;
}

const CHAT = "chat-1";
const ME = "user-me";
const OLD_RUN = "run-old";
const fresh = { kind: "message", status: "streaming", content: "", provider: "openrouter", model: "gpt-oss-20b", reasoning: null, for_user_id: ME, key_user_id: ME, run_id: "run-new", meta: {} };

describe("answerSlot", () => {
  test("a retry writes into the answer it replaces, keeping its place", async () => {
    const rows: Row[] = [
      { id: "q", chat_id: CHAT, role: "user", seq: 1 },
      { id: "a", chat_id: CHAT, role: "assistant", seq: 2, status: "error", content: "The model returned an empty reply.", meta: { error: "other" }, for_user_id: ME, run_id: OLD_RUN, created_at: "2026-10-23T20:49:00Z" },
      { id: "later", chat_id: CHAT, role: "user", seq: 3 },
    ];
    const { data } = await answerSlot(fakeDb(rows), CHAT, ME, [{ run_id: OLD_RUN }], fresh);
    assert.equal(data?.id, "a");
    assert.equal(rows.length, 3, "no message added");
    const a = rows.find((r) => r.id === "a")!;
    assert.equal(a.seq, 2);
    assert.equal(a.status, "streaming");
    assert.equal(a.content, "");
    assert.deepEqual(a.meta, {});
    assert.equal(a.run_id, "run-new");
    assert.notEqual(a.created_at, "2026-10-23T20:49:00Z");
  });

  test("a regenerated good answer is replaced too", async () => {
    const rows: Row[] = [{ id: "a", chat_id: CHAT, role: "assistant", seq: 2, status: "done", content: "Hi", for_user_id: ME, run_id: OLD_RUN }];
    const { data } = await answerSlot(fakeDb(rows), CHAT, ME, [{ run_id: OLD_RUN }], fresh);
    assert.equal(data?.id, "a");
    assert.equal(rows[0]!.content, "");
  });

  test("a first run adds a message", async () => {
    const rows: Row[] = [{ id: "q", chat_id: CHAT, role: "user", seq: 1 }];
    const { data } = await answerSlot(fakeDb(rows), CHAT, ME, [{ run_id: null }], fresh);
    assert.equal(rows.length, 2);
    assert.equal(data?.id, rows[1]!.id);
    assert.equal(rows[1]!.role, "assistant");
    assert.equal(rows[1]!.chat_id, CHAT);
  });

  test("an answer that is not the asker's, or still being written, is left alone", async () => {
    const rows: Row[] = [
      { id: "theirs", chat_id: CHAT, role: "assistant", seq: 2, status: "error", for_user_id: "someone-else", run_id: OLD_RUN },
      { id: "busy", chat_id: CHAT, role: "assistant", seq: 3, status: "streaming", for_user_id: ME, run_id: "run-busy" },
    ];
    await answerSlot(fakeDb(rows), CHAT, ME, [{ run_id: OLD_RUN }], fresh);
    await answerSlot(fakeDb(rows), CHAT, ME, [{ run_id: "run-busy" }], fresh);
    assert.equal(rows.length, 4);
    assert.equal(rows[0]!.status, "error");
    assert.equal(rows[1]!.status, "streaming");
  });

  test("questions from different old runs get a new message", async () => {
    const rows: Row[] = [{ id: "a", chat_id: CHAT, role: "assistant", seq: 2, status: "error", for_user_id: ME, run_id: OLD_RUN }];
    await answerSlot(fakeDb(rows), CHAT, ME, [{ run_id: OLD_RUN }, { run_id: "run-other" }], fresh);
    assert.equal(rows.length, 2);
  });
});
