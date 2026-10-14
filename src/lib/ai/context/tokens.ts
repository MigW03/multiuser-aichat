// Token budgeting against a chat's agreed context window. Pure functions, no database or framework imports.

/**
 * Budget for chats without an agreed window yet. Every model we offer has at least this much, so one
 * shared number keeps a 1M model and a 200k model in the same chat from budgeting against each other.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Rough size of text the provider hasn't counted for us: about 4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The most a request may hold, leaving room for the reply: window minus max(10%, 16k). */
export function inputCeiling(window: number): number {
  return window - Math.max(Math.ceil(window * 0.1), 16_000);
}
