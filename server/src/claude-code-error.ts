import type { ClaudeCodeErrorCode } from "@mc/shared";

/** A failed AI step run with the person's own Claude Code login. `message` is written to be shown. */
export class ClaudeCodeError extends Error {
  constructor(
    readonly code: ClaudeCodeErrorCode,
    message: string,
  ) {
    super(message);
  }
}
