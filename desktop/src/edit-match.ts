import { EditMatchError, replaceText as replace } from "@mc/shared";
import { FolderError } from "./folder-fs.ts";

// The matcher lives in shared/src/edit-match.ts (the server's design_edit uses it too). Here its errors become file errors.

/** Replaces `oldString` with `newString` in `content`. Throws a FolderError (no_match, ambiguous, bad_request) the AI can act on. */
export function replaceText(content: string, oldString: string, newString: string, replaceAll = false): string {
  try {
    return replace(content, oldString, newString, replaceAll);
  } catch (e) {
    if (e instanceof EditMatchError) throw new FolderError(e.code, e.message);
    throw e;
  }
}
