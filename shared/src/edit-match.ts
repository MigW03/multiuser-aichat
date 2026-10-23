/** Why a replacement could not be made. The desktop app turns it into its own file error. */
export class EditMatchError extends Error {
  constructor(
    readonly code: "bad_request" | "ambiguous" | "no_match",
    message: string,
  ) {
    super(message);
  }
}

// Find-and-replace for the AI's `edit` tool (and design_edit). Models rarely reproduce a block of code character for character: they
// drift in indentation, trailing spaces, quote escaping. So, as in opencode's edit tool (MIT; itself adapted from
// Cline and Gemini CLI), the text is looked for with a chain of matchers from strict to tolerant, and the first one
// that finds exactly one place wins. Whatever matches is only a proposal: the host sees the resulting diff before
// anything is written, so a tolerant match that picks the wrong place is caught there.

/** Each matcher yields substrings of `content` that it considers to be `find`. */
type Matcher = (content: string, find: string) => Generator<string>;

const lines = (s: string) => s.split("\n");

/** Exactly what was given. */
const exact: Matcher = function* (_content, find) {
  yield find;
};

/** Lines compare equal when trimmed. Catches wrong indentation and trailing spaces. */
const lineTrimmed: Matcher = function* (content, find) {
  const hay = lines(content);
  const needle = lines(find);
  if (needle.at(-1) === "") needle.pop();
  if (needle.length === 0) return;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((n, j) => hay[i + j]!.trim() === n.trim())) yield hay.slice(i, i + needle.length).join("\n");
  }
};

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "" || b === "") return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

const similarity = (a: string, b: string) => {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
};

/**
 * A block of 3+ lines whose first and last lines match (trimmed) and whose middle is similar. For when the model
 * remembered the ends of a block and got the inside slightly wrong.
 */
const blockAnchor: Matcher = function* (content, find) {
  const hay = lines(content);
  const needle = lines(find);
  if (needle.at(-1) === "") needle.pop();
  // A tolerant search over a big block gets expensive; the cheaper matchers above and below still apply.
  if (needle.length < 3 || needle.length > 200 || needle.some((l) => l.length > 400)) return;
  const first = needle[0]!.trim();
  const last = needle.at(-1)!.trim();
  const candidates: { start: number; end: number }[] = [];
  for (let i = 0; i < hay.length; i++) {
    if (hay[i]!.trim() !== first) continue;
    // The block in the file is about as long as the one the model wrote.
    for (let j = i + 2; j < hay.length && j <= i + needle.length * 2 + 5; j++) {
      if (hay[j]!.trim() === last) {
        candidates.push({ start: i, end: j });
        break;
      }
    }
  }
  if (candidates.length === 0) return;
  const score = ({ start, end }: { start: number; end: number }) => {
    const inner = Math.min(needle.length - 2, end - start - 1);
    if (inner <= 0) return 1;
    let total = 0;
    for (let k = 1; k <= inner; k++) total += similarity(hay[start + k]!.trim(), needle[k]!.trim());
    return total / inner;
  };
  // One candidate: accept it if it is at all alike. Several: take the best one, if it is clearly alike.
  let best = candidates[0]!;
  let bestScore = score(best);
  for (const c of candidates.slice(1)) {
    const s = score(c);
    if (s > bestScore) [best, bestScore] = [c, s];
  }
  if (bestScore >= (candidates.length === 1 ? 0.3 : 0.6)) yield hay.slice(best.start, best.end + 1).join("\n");
};

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Lines compare equal after runs of whitespace are collapsed. */
const whitespaceNormalized: Matcher = function* (content, find) {
  const hay = lines(content);
  const needle = lines(find);
  if (needle.at(-1) === "") needle.pop();
  if (needle.length === 0 || squash(find) === "") return;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((n, j) => squash(hay[i + j]!) === squash(n))) yield hay.slice(i, i + needle.length).join("\n");
  }
};

const dedent = (text: string) => {
  const ls = lines(text);
  const indents = ls.filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return ls.map((l) => (l.trim() === "" ? l : l.slice(cut))).join("\n");
};

/** The same block indented differently (the model pasted it from another nesting level). */
const indentationFlexible: Matcher = function* (content, find) {
  const needle = lines(dedent(find));
  if (needle.at(-1) === "") needle.pop();
  if (needle.length === 0) return;
  const hay = lines(content);
  for (let i = 0; i + needle.length <= hay.length; i++) {
    const block = hay.slice(i, i + needle.length).join("\n");
    if (dedent(block) === needle.join("\n")) yield block;
  }
};

const unescape = (s: string) =>
  s.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_m, c: string) => ({ n: "\n", t: "\t", r: "\r", "'": "'", '"': '"', "`": "`", "\\": "\\", "\n": "\n", $: "$" })[c] ?? c);

/** The model wrote escape sequences literally (\n for a line break, \" for a quote). */
const escapeNormalized: Matcher = function* (content, find) {
  const plain = unescape(find);
  if (plain === find) return;
  if (content.includes(plain)) yield plain;
  const hay = lines(content);
  const needle = lines(plain);
  for (let i = 0; i + needle.length <= hay.length; i++) {
    const block = hay.slice(i, i + needle.length).join("\n");
    if (unescape(block) === plain) yield block;
  }
};

/** Leading or trailing blank space in the text to find is dropped. */
const trimmedBoundary: Matcher = function* (content, find) {
  const trimmed = find.trim();
  if (trimmed === "" || trimmed === find) return;
  if (content.includes(trimmed)) yield trimmed;
};

const MATCHERS: Matcher[] = [exact, lineTrimmed, blockAnchor, whitespaceNormalized, indentationFlexible, escapeNormalized, trimmedBoundary];

/** Where `needle` occurs in `hay`, as start offsets. */
function occurrences(hay: string, needle: string): number[] {
  const at: number[] = [];
  if (needle === "") return at;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) at.push(i);
  return at;
}

const BOM = "\uFEFF";

/** The shortest leading whitespace among the non-blank lines. */
function baseIndent(text: string): string {
  let best: string | null = null;
  for (const l of lines(text)) {
    if (l.trim() === "") continue;
    const ws = /^[ \t]*/.exec(l)![0];
    if (best === null || ws.length < best.length) best = ws;
  }
  return best ?? "";
}

/**
 * The text that goes in where `candidate` was found. When the model's version of the old text sat at a different
 * indentation than the file's, its new text is shifted the same way. A trailing line break the matched block does
 * not have is dropped, so the line after it is not pushed down.
 */
function adapt(replacement: string, find: string, candidate: string): string {
  let out = replacement;
  if (candidate !== find) {
    const fromFind = baseIndent(find);
    const inFile = baseIndent(candidate);
    if (fromFind !== inFile && baseIndent(out) === fromFind && inFile.startsWith(fromFind)) {
      const add = inFile.slice(fromFind.length);
      out = lines(out)
        .map((l) => (l.trim() === "" ? l : add + l))
        .join("\n");
    }
    if (find.endsWith("\n") && !candidate.endsWith("\n") && out.endsWith("\n")) out = out.slice(0, -1);
  }
  return out;
}

/** Replaces `oldString` with `newString` in `content`. Throws an EditMatchError (no_match, ambiguous, bad_request) the AI can act on. */
export function replaceText(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) throw new EditMatchError("bad_request", "oldString and newString are the same, so nothing would change.");
  if (oldString === "") throw new EditMatchError("bad_request", "oldString is empty. To create or replace a whole file, use write.");

  // Work on "\n" text and the file's own line ending is put back afterwards; a byte order mark is kept.
  const bom = content.startsWith(BOM);
  const body = bom ? content.slice(1) : content;
  const crlf = body.includes("\r\n");
  const text = crlf ? body.replaceAll("\r\n", "\n") : body;
  const find = oldString.replaceAll("\r\n", "\n");
  const replacement = newString.replaceAll("\r\n", "\n");

  let sawAmbiguous = false;
  for (const matcher of MATCHERS) {
    for (const candidate of matcher(text, find)) {
      const at = occurrences(text, candidate);
      if (at.length === 0) continue;
      if (!replaceAll && at.length > 1) {
        sawAmbiguous = true;
        continue;
      }
      const put = adapt(replacement, find, candidate);
      const out = replaceAll
        ? at.reduceRight((acc, i) => acc.slice(0, i) + put + acc.slice(i + candidate.length), text)
        : text.slice(0, at[0]!) + put + text.slice(at[0]! + candidate.length);
      return (bom ? BOM : "") + (crlf ? out.replaceAll("\n", "\r\n") : out);
    }
  }
  if (sawAmbiguous) {
    throw new EditMatchError("ambiguous", "oldString was found more than once. Include more surrounding lines to make it unique, or set replaceAll to change every occurrence.");
  }
  throw new EditMatchError("no_match", "oldString was not found in the file. Read the file again and copy the text exactly, including indentation.");
}
