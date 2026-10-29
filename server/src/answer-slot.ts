import type { Admin } from "./supabase.ts";

/**
 * The message a new AI run writes its answer into. A retry takes the place of the answer it replaces: the same message,
 * so it keeps its spot in the chat (the questions of a retried run still carry that run's id). Any other run adds a message.
 * `row` is everything the answer starts with; a retry also gets a fresh time, since it is a new attempt.
 */
export async function answerSlot(
  db: Admin,
  chatId: string,
  asker: string | null,
  questions: { run_id: string | null }[],
  row: Record<string, unknown>,
): Promise<{ data: { id: string } | null; error: unknown }> {
  const retried = [...new Set(questions.map((q) => q.run_id).filter((r): r is string => !!r))];
  const old =
    retried.length === 1 && asker
      ? (await db.from("messages").select("id").eq("chat_id", chatId).eq("role", "assistant").eq("run_id", retried[0]!).eq("for_user_id", asker).in("status", ["done", "error"]).maybeSingle()).data
      : null;
  return old
    ? db.from("messages").update({ ...row, created_at: new Date().toISOString() }).eq("id", old.id).select("id").single()
    : db.from("messages").insert({ chat_id: chatId, role: "assistant", ...row }).select("id").single();
}
