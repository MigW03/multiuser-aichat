// Splits composer text into styled pieces for the live Markdown backdrop. The pieces always add back up to the exact
// text, one line per entry, so the styled copy lines up with the textarea above it.

export type SpanKind = "bold" | "italic" | "strike" | "code" | "mark" | "list";
export type Span = { text: string; kind?: SpanKind };
export type LineKind = "fence" | "code" | "add" | "del" | "heading" | "quote";
export type StyledLine = { spans: Span[]; kind?: LineKind; first?: boolean; last?: boolean };

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING = /^( {0,3}#{1,6})([ \t]+)/;
const QUOTE = /^( {0,3}>[ \t]?)+/;
const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)/;
const DIFF_LANGS = new Set(["diff", "patch"]);

// Inline code, **bold**, ~~strike~~, then *italic*. Plain text between matches stays as it is.
const INLINE = /(`+)([^`]|[^`].*?[^`])\1(?!`)|\*\*(\S(?:.*?\S)?)\*\*|~~(\S(?:.*?\S)?)~~|\*([^\s*](?:[^*]*?[^\s*])?)\*/g;

function inline(text: string): Span[] {
  const spans: Span[] = [];
  let at = 0;
  const plain = (to: number) => {
    if (to > at) spans.push({ text: text.slice(at, to) });
  };
  for (const m of text.matchAll(INLINE)) {
    const start = m.index;
    plain(start);
    if (m[1] !== undefined) {
      spans.push({ text: m[1], kind: "mark" }, { text: m[2]!, kind: "code" }, { text: m[1], kind: "mark" });
    } else {
      const [mark, body, kind] = m[3] !== undefined ? ["**", m[3], "bold"] : m[4] !== undefined ? ["~~", m[4], "strike"] : ["*", m[5]!, "italic"];
      spans.push({ text: mark!, kind: "mark" }, { text: body!, kind: kind as SpanKind }, { text: mark!, kind: "mark" });
    }
    at = start + m[0].length;
  }
  plain(text.length);
  return spans;
}

/** One entry per line of `text` (split on "\n"). */
export function styleMarkdown(text: string): StyledLine[] {
  const out: StyledLine[] = [];
  let fence: { char: string; len: number; diff: boolean } | null = null;
  let fenceStart = -1;
  for (const line of text.split("\n")) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) {
        out.push({ spans: [{ text: line }], kind: "fence", last: true });
        out[fenceStart]!.first = true;
        fence = null;
        continue;
      }
      const kind: LineKind = fence.diff && line.startsWith("+") && !line.startsWith("+++") ? "add" : fence.diff && line.startsWith("-") && !line.startsWith("---") ? "del" : "code";
      out.push({ spans: [{ text: line }], kind });
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open && !(open[2]![0] === "`" && open[4]!.includes("`"))) {
      fence = { char: open[2]![0]!, len: open[2]!.length, diff: DIFF_LANGS.has(open[3]!.toLowerCase()) };
      fenceStart = out.length;
      out.push({ spans: [{ text: line }], kind: "fence" });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ spans: [{ text: heading[1]!, kind: "mark" }, { text: heading[2]! }, ...inline(line.slice(heading[0].length))], kind: "heading" });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      out.push({ spans: [{ text: quote[0], kind: "mark" }, ...inline(line.slice(quote[0].length))], kind: "quote" });
      continue;
    }
    const list = LIST.exec(line);
    if (list) {
      const lead = list[1]!;
      out.push({ spans: [...(lead ? [{ text: lead }] : []), { text: list[2]!, kind: "list" }, { text: list[3]! }, ...inline(line.slice(list[0].length))] });
      continue;
    }
    out.push({ spans: inline(line) });
  }
  // An opening fence that never closes runs to the end of the text.
  if (fence) {
    out[fenceStart]!.first = true;
    out[out.length - 1]!.last = true;
  }
  return out;
}
