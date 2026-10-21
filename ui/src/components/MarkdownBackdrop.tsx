import { memo, type Ref } from "react";
import { styleMarkdown } from "../lib/markdownLive.ts";

/**
 * The composer's text drawn with Markdown styling, sitting on top of the (see-through) textarea. It never takes
 * clicks. Styling must not change how wide any character is, or the caret in the textarea would drift away from
 * the styled text: no mono font, no real bold, no padding on inline pieces.
 */
export const MarkdownBackdrop = memo(function MarkdownBackdrop({ text, innerRef }: { text: string; innerRef: Ref<HTMLDivElement> }) {
  const lines = styleMarkdown(text);
  return (
    <div className="md-backdrop" aria-hidden>
      <div className="md-inner" ref={innerRef}>
        {lines.map((line, i) => (
          <div key={i} className={["md-line", line.kind, line.first && "first", line.last && "last"].filter(Boolean).join(" ")}>
            {line.spans.length === 0
              ? "​"
              : line.spans.map((s, j) => (s.kind ? <span key={j} className={`md-${s.kind}`}>{s.text}</span> : s.text))}
          </div>
        ))}
      </div>
    </div>
  );
});
