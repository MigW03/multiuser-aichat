import type { ChatMessage } from "./index.ts";

/** Edit a message you wrote. `content` is the words only: a leading design marker is kept by the server. */
export type EditMessageRequest = { content: string; /** Have the AI answer the edited message again, replacing its old reply. */ regenerate?: boolean };
/** `content` is the message as saved (with its design marker, if it had one). `edited_at` is null when nothing changed. */
export type EditMessageResponse = { id: string; content: string; edited_at: string | null; regenerating: boolean };

/** Fields the edit rules look at. */
export type EditableFields = Pick<ChatMessage, "author_id" | "role" | "kind" | "status">;

/**
 * Whether `userId` may edit this message right now. People edit only their own plain messages (never an AI answer, a
 * summary request or someone else's), and only once the AI is done with it. The server applies the same rule.
 */
export function canEditMessage(m: EditableFields, userId: string): boolean {
  return m.role === "user" && m.kind === "message" && m.author_id !== null && m.author_id === userId && (m.status === "done" || m.status === "error");
}

/** The AI answer written for a user message: the assistant message of the same run, made for that author. */
export function answerOf(m: Pick<ChatMessage, "run_id" | "author_id">, all: readonly ChatMessage[]): ChatMessage | undefined {
  if (!m.run_id) return undefined;
  return all.find((a) => a.role === "assistant" && a.kind === "message" && a.run_id === m.run_id && a.for_user_id === m.author_id);
}

/** An answer that came after one of its questions was edited: the AI answered the edited text. */
export function isRegenerated(answer: Pick<ChatMessage, "role" | "run_id" | "for_user_id" | "created_at">, all: readonly ChatMessage[]): boolean {
  if (answer.role !== "assistant" || !answer.run_id) return false;
  const made = Date.parse(answer.created_at);
  return all.some((q) => q.role === "user" && q.run_id === answer.run_id && q.author_id === answer.for_user_id && !!q.edited_at && Date.parse(q.edited_at) <= made);
}

/** Your newest message that you may still edit (for the Up arrow in an empty composer). */
export function lastEditableOf(all: readonly ChatMessage[], userId: string): ChatMessage | undefined {
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]!;
    if (m.author_id === userId && m.role === "user" && m.kind === "message") return canEditMessage(m, userId) ? m : undefined;
  }
  return undefined;
}
