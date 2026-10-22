/**
 * Generated UI in AI answers. An answer is Markdown; a fenced block marked `openui-lang` holds a small interface the
 * app draws from its own pieces (OpenUI Lang). Everything else stays Markdown, including code blocks in other languages.
 */

export type AnswerPart = { kind: "markdown"; text: string } | { kind: "ui"; code: string; closed: boolean };

const UI_LANGS = new Set(["openui-lang", "openui"]);

/** Most generated blocks an answer may show; later ones stay as code. */
export const GENUI_MAX_BLOCKS = 4;
/** Longest program drawn; a longer one stays as code. */
export const GENUI_MAX_CHARS = 20_000;

/**
 * Splits an answer into Markdown and generated-UI parts, in order. A block still being written (no closing fence yet)
 * comes back with `closed: false`. Fences of other languages are left alone, even when they contain an openui fence.
 */
export function splitAnswer(text: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  const lines = text.split("\n");
  let markdown: string[] = [];
  let ui: string[] | null = null;
  /** The fence of a non-UI code block we are inside: its marker character and length. */
  let other: { char: string; len: number } | null = null;
  let blocks = 0;

  const flushMarkdown = () => {
    if (markdown.length && markdown.join("\n").trim()) parts.push({ kind: "markdown", text: markdown.join("\n") });
    markdown = [];
  };

  for (const line of lines) {
    const fence = /^ {0,3}(`{3,}|~{3,})\s*([\w-]*)\s*$/.exec(line);
    if (ui) {
      if (fence && fence[1]!.startsWith("`") && !fence[2]) {
        parts.push({ kind: "ui", code: ui.join("\n"), closed: true });
        ui = null;
      } else ui.push(line);
      continue;
    }
    if (other) {
      if (fence && fence[1]![0] === other.char && fence[1]!.length >= other.len && !fence[2]) other = null;
      markdown.push(line);
      continue;
    }
    if (fence && fence[1]!.startsWith("`") && UI_LANGS.has(fence[2]!.toLowerCase()) && blocks < GENUI_MAX_BLOCKS) {
      flushMarkdown();
      ui = [];
      blocks++;
      continue;
    }
    if (fence) other = { char: fence[1]![0]!, len: fence[1]!.length };
    markdown.push(line);
  }
  if (ui) parts.push({ kind: "ui", code: ui.join("\n"), closed: false });
  flushMarkdown();
  return parts.map((p) => (p.kind === "ui" && p.code.length > GENUI_MAX_CHARS ? { kind: "markdown", text: asCode(p.code) } : p));
}

/** A program shown as a plain code block, for when it can't be drawn. */
export function asCode(code: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${code}\n${fence}`;
}

/** An answer as one line of text for previews (a quoted reply): each generated block reads "[visual]". */
export const answerPreview = (text: string) => splitAnswer(text).map((p) => (p.kind === "ui" ? "[visual]" : p.text)).join(" ");

/** Whether an answer has a generated-UI block (closed or still being written). */
export const hasGeneratedUi = (text: string) => splitAnswer(text).some((p) => p.kind === "ui");

/**
 * What a form submission or a picked option puts in the composer: the message, then each answered field on its own line,
 * then any extra details the AI attached to the button. Nothing is hidden: the person sees all of it before sending.
 */
export function draftFromAction(message: string, formState: unknown, formName?: string, context?: unknown): string {
  const lines = [message.trim()];
  const form = formName && isRecord(formState) ? formState[formName] : undefined;
  if (isRecord(form)) {
    for (const [name, raw] of Object.entries(form)) {
      const value = isRecord(raw) && "value" in raw ? raw.value : raw;
      if (value === undefined || value === null || value === "") continue;
      const label = name.replace(/[_-]+/g, " ").trim();
      lines.push(`- ${label.charAt(0).toUpperCase()}${label.slice(1)}: ${String(typeof value === "object" ? JSON.stringify(value) : value).replace(/\s+/g, " ").trim()}`);
    }
  }
  if (context !== undefined && context !== null && context !== "") lines.push(`Details: ${typeof context === "string" ? context : JSON.stringify(context)}`);
  return lines.filter(Boolean).join("\n").slice(0, 4000);
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
