import "./no-devtools.ts"; // first: before @openuidev/react-lang loads
import { asCode, draftFromAction, splitAnswer } from "@mc/shared";
import { BuiltinActionType, Renderer, type ActionEvent, type ParseResult } from "@openuidev/react-lang";
import { Component, useCallback, useMemo, useState, type ReactNode } from "react";
import { Markdown } from "../components/Markdown.tsx";
import { useToast } from "../components/kit.tsx";
import { copyText } from "../lib/actions.ts";
import { draftInOpenChat } from "../lib/drafts.ts";
import { GenTextContext, genLibrary } from "./library.tsx";

type Props = {
  text: string;
  /** The answer is still being written: the last block may be unfinished. */
  streaming: boolean;
  /** A click in the generated UI drafts this reply in the reader's composer. Absent (a note): drafts in the open chat. */
  onDraft?: (text: string) => void;
};

const markdownText = (text: string) => <Markdown text={text} />;

/** An AI answer: Markdown, with any openui-lang blocks drawn as interfaces built from the app's own pieces. */
export function GeneratedAnswer({ text, streaming, onDraft }: Props) {
  const parts = useMemo(() => splitAnswer(text), [text]);
  if (!parts.some((p) => p.kind === "ui")) return <Markdown text={text} />;
  return (
    <GenTextContext.Provider value={markdownText}>
      <div className="gen-answer">
        {parts.map((p, i) =>
          p.kind === "markdown" ? <Markdown key={i} text={p.text} /> : <GenBlock key={i} code={p.code} streaming={streaming && !p.closed} onDraft={onDraft} />,
        )}
      </div>
    </GenTextContext.Provider>
  );
}

function GenBlock({ code, streaming, onDraft }: { code: string; streaming: boolean; onDraft?: (text: string) => void }) {
  const toast = useToast();
  const [drawn, setDrawn] = useState<boolean | null>(null);

  const onAction = useCallback(
    (event: ActionEvent) => {
      if (event.type === BuiltinActionType.ContinueConversation) {
        const draft = draftFromAction(event.humanFriendlyMessage, event.formState, event.formName, event.params?.context);
        if (!draft) return;
        // In a chat: a reply to this answer. In a note: a message in the open chat, or copied when no chat is open.
        if (onDraft) onDraft(draft);
        else if (!draftInOpenChat(draft)) void copyText(draft).then((ok) => toast.push(ok ? "Copied. Open a chat to paste it" : "Could not copy", "info"));
      } else if (event.type === BuiltinActionType.OpenUrl) {
        const url = safeUrl(event.params?.url);
        if (url) window.open(url, "_blank", "noopener,noreferrer");
        else toast.push("That link can't be opened", "error");
      } else if (event.type === "CopyText") {
        // The toast shows what was copied: the button's label alone could say something else.
        const copied = String(event.params?.text ?? "").slice(0, 20_000);
        void copyText(copied).then((ok) => toast.push(ok ? `Copied: ${copied.replace(/\s+/g, " ").slice(0, 80)}${copied.length > 80 ? "…" : ""}` : "Could not copy", "info"));
      }
    },
    [onDraft, toast],
  );

  // Nothing could be drawn once the block is complete: show it as code, so the answer still reads.
  const onParseResult = useCallback((result: ParseResult | null) => setDrawn(!!result?.root), []);
  if (!streaming && drawn === false) return <Markdown text={asCode(code)} />;

  return (
    <BlockBoundary fallback={<Markdown text={asCode(code)} />}>
      <div className="gen-block">
        <Renderer library={genLibrary} response={code} isStreaming={streaming} onAction={onAction} onParseResult={onParseResult} onError={quiet} />
      </div>
    </BlockBoundary>
  );
}

/** Generation mistakes are expected now and then and the block falls back to code; they don't need the console. */
const quiet = () => undefined;

/** Only web links open, in the browser (the desktop app opens https only). */
function safeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A piece that fails to draw never takes the chat down with it. */
class BlockBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
