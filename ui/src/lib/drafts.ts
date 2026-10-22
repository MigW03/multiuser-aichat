// Where a click in generated UI outside a chat (a note) drafts its reply: the composer of the chat that is open, if any.

type Target = (text: string) => void;
let target: Target | null = null;

/** The open chat registers its composer; the returned function unregisters it. */
export function setDraftTarget(next: Target): () => void {
  target = next;
  return () => {
    if (target === next) target = null;
  };
}

/** Puts the text in the open chat's composer. False when no chat is open. */
export function draftInOpenChat(text: string): boolean {
  if (!target) return false;
  target(text);
  return true;
}
