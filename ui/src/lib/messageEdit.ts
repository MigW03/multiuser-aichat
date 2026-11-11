import { IMAGE_ONLY_TEXT, LIMITS, parseDesignMarker } from "@mc/shared";

/** The words of a message as the edit box shows them: no design marker, and no placeholder for a picture-only message. */
export function editableWords(content: string, pictures: number): string {
  const words = parseDesignMarker(content)?.rest ?? content;
  return pictures > 0 && words === IMAGE_ONLY_TEXT ? "" : words;
}

/** What the editor lets through: the text to save, and whether Save is on. Nothing changed, nothing to say, or too long: off. */
export function editState(text: string, initial: string, hasPictures: boolean): { text: string; canSave: boolean } {
  const trimmed = text.trim();
  return { text: trimmed, canSave: (trimmed.length > 0 || hasPictures) && trimmed !== initial.trim() && text.length <= LIMITS.messageChars };
}

/** How long a finger rests on a message before the touch menu opens. */
export const LONG_PRESS_MS = 450;
/** A finger that moves farther than this (px) is scrolling, not pressing. */
export const LONG_PRESS_SLOP = 10;
