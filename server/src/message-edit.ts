import { IMAGE_ONLY_TEXT, LIMITS, canEditMessage, parseDesignMarker, type ChatMessage } from "@mc/shared";

/** The stored message the edit rules look at. */
export type EditTarget = Pick<ChatMessage, "id" | "chat_id" | "author_id" | "role" | "kind" | "status" | "content" | "run_id" | "images">;
/** The AI answer written for that message, if there is one. */
export type EditAnswer = Pick<ChatMessage, "id" | "status"> | null;

export type EditDecision =
  | { ok: true; content: string; changed: boolean; regenerate: boolean }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

export const EDIT_NOT_YOURS = "You can only edit your own messages.";
export const EDIT_WAIT = "Wait for the AI to finish before editing this message.";

/** The leading design marker of a message, as stored (empty when there is none). The app writes it, so an edit keeps it as it was. */
export function markerPrefix(content: string): string {
  const marked = parseDesignMarker(content);
  return marked ? content.slice(0, content.length - marked.rest.length) : "";
}

/**
 * Decides an edit. `words` is the new text without any design marker. The caller has already checked that `userId` is in
 * the chat; this is where "only the author, only a finished plain message" is decided, so the rule lives in one place.
 */
export function decideEdit(target: EditTarget | null, userId: string, words: string, regenerate: boolean, answer: EditAnswer, hasKey: boolean): EditDecision {
  if (!target) return { ok: false, status: 404, error: "That doesn't exist, or you don't have access to it." };
  if (target.author_id !== userId || target.role !== "user" || target.kind !== "message") return { ok: false, status: 403, error: EDIT_NOT_YOURS };
  if (!canEditMessage(target, userId)) return { ok: false, status: 409, error: EDIT_WAIT };

  const text = words.trim();
  const pictures = target.images.length > 0;
  if (!text && !pictures) return { ok: false, status: 400, error: "A message can't be empty." };
  const marker = markerPrefix(target.content);
  const content = `${marker}${text || IMAGE_ONLY_TEXT}`;
  if (content.length > LIMITS.messageChars + marker.length) return { ok: false, status: 400, error: `Messages can be up to ${LIMITS.messageChars.toLocaleString("en-US")} characters.` };

  if (regenerate) {
    if (!answer) return { ok: false, status: 400, error: "There is no AI reply to write again." };
    if (answer.status !== "done" && answer.status !== "error") return { ok: false, status: 409, error: "That reply is still being written." };
    if (!hasKey) return { ok: false, status: 400, error: "Add an AI key in Settings first." };
  }
  return { ok: true, content, changed: content !== target.content, regenerate };
}
