// Helpers for code blocks in answers: split into lines, tell added/removed lines in a diff, decide on line numbers.

/** Blocks with more lines than this get line numbers; short snippets stay clean. */
export const NUMBERED_FROM = 5;

export type CodeLine = { text: string; kind: "add" | "del" | "plain" };

/** The lines of a block. One trailing line break is dropped (markdown adds it). Only diff/patch blocks mark added and removed lines. */
export function codeLines(code: string, lang?: string): CodeLine[] {
  const diff = lang === "diff" || lang === "patch";
  return code
    .replace(/\n$/, "")
    .split("\n")
    .map((text) => ({
      text,
      kind: diff && text.startsWith("+") && !text.startsWith("+++") ? "add" : diff && text.startsWith("-") && !text.startsWith("---") ? "del" : "plain",
    }));
}

export function showLineNumbers(lines: number): boolean {
  return lines > NUMBERED_FROM;
}
