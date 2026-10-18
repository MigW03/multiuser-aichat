import { LIMITS, type ChatMessage, type ModelChoice, type Person, type Reasoning } from "@mc/shared";
import { ArrowUp, CornerUpLeft, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { findSecret, maskSecret } from "../lib/secrets.ts";
import { SecretWarning } from "./Dialogs.tsx";
import { useModelReasoning } from "../lib/models.ts";
import { ModelPicker, ReasoningPicker } from "./Pickers.tsx";
import { UsageRing } from "./PlanUsage.tsx";
import { Avatar, ICON, ICON_SM, STROKE } from "./kit.tsx";

export type OutgoingMessage = { content: string; mentions: string[]; replyTo: string | null; quote: string | null };

/** What the next message replies to: a whole message, or just the highlighted part of an answer. */
export type ReplyTarget = { message: ChatMessage; who: string; quote?: string };

type Props = {
  /** Everyone in the chat except the signed-in person: the people @ can tag. */
  people: Person[];
  choice: ModelChoice | null;
  onModel: (c: Pick<ModelChoice, "provider" | "model">) => void;
  onReasoning: (r: Reasoning) => void;
  replyTo: ReplyTarget | null;
  onClearReply: () => void;
  /** An answer the signed-in person asked for is being written: show Stop. */
  canStop: boolean;
  onStop: () => void;
  onTyping: () => void;
  /** Resolves false when sending failed, so the text can be put back. */
  onSend: (m: OutgoingMessage) => Promise<boolean>;
  placeholder: string;
  focusKey: string;
  /** Small line on the left above the input, e.g. who is typing. */
  status?: ReactNode;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** People whose "@Name" appears in the text as a whole word. Editing the @ out of the text un-tags them. */
export function mentionedIn(text: string, people: Person[]): string[] {
  return people
    .filter((p) => new RegExp(`(^|\\s)@${escapeRe(p.display_name)}(?![\\p{L}\\p{N}_])`, "u").test(text))
    .map((p) => p.id);
}

export function Composer({ people, choice, onModel, onReasoning, replyTo, onClearReply, canStop, onStop, onTyping, onSend, placeholder, focusKey, status }: Props) {
  const thinking = useModelReasoning(choice);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [warning, setWarning] = useState<{ kind: string; snippet: string } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);

  // After a name is inserted the caret goes right behind it, before anything typed next.
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    ref.current?.focus();
    ref.current?.setSelectionRange(pos, pos);
    setCaret(pos);
  }, [text]);

  useEffect(() => {
    ref.current?.focus();
  }, [focusKey, replyTo]);

  // Grow with the text, up to about eight lines.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // "@ben" typed at the caret opens the list of people.
  const token = useMemo(() => {
    const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
    return m ? { start: caret - m[2]!.length - 1, query: m[2]! } : null;
  }, [text, caret]);
  const suggestions = useMemo(() => {
    if (!token || dismissedAt === token.start) return [];
    const q = token.query.toLowerCase();
    return people.filter((p) => p.display_name.toLowerCase().includes(q)).slice(0, 6);
  }, [token, people, dismissedAt]);
  useEffect(() => setHighlight(0), [token?.query]);

  function pick(p: Person) {
    if (!token) return;
    const before = text.slice(0, token.start);
    const after = text.slice(caret);
    const next = `${before}@${p.display_name} ${after}`;
    setText(next);
    pendingCaret.current = before.length + p.display_name.length + 2;
  }

  async function dispatch(content: string) {
    const outgoing: OutgoingMessage = { content, mentions: mentionedIn(content, people), replyTo: replyTo?.message.id ?? null, quote: replyTo?.quote ?? null };
    setText("");
    setWarning(null);
    const ok = await onSend(outgoing);
    if (!ok) setText((cur) => (cur ? cur : content));
  }

  function submit() {
    const content = text.trim();
    if (!content) return;
    const secret = findSecret(content);
    if (secret) return setWarning({ kind: secret.kind, snippet: maskSecret(secret.match) });
    void dispatch(content);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(suggestions[highlight]!);
        return;
      }
      if (e.key === "Escape" && token) {
        e.preventDefault();
        setDismissedAt(token.start);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  const empty = text.trim().length === 0;
  // While an answer is written the button is Stop; once the person types it is Send again and the message queues.
  const showStop = canStop && empty;

  return (
    <div className="composer-wrap">
      <div className="composer-col">
        <div className="composer-top">
          {status}
          <span className="grow" />
          <UsageRing enabled={choice?.provider === "chatgpt"} answering={canStop} />
          <ModelPicker choice={choice} onChoose={onModel} />
          <ReasoningPicker levels={thinking.levels} value={thinking.effective} onChange={onReasoning} disabled={!choice} />
        </div>
        <div className="composer">
          {replyTo && (
            <div className="reply-strip">
              <CornerUpLeft size={ICON_SM} strokeWidth={STROKE} aria-hidden />
              <span className="truncate">
                Replying to <b>{replyTo.who}</b> · {replyTo.quote ? `“${replyTo.quote}”` : replyTo.message.content.replace(/\s+/g, " ").slice(0, 100)}
              </span>
              <button type="button" className="icon-btn" aria-label="Cancel reply" onClick={onClearReply}>
                <X size={ICON_SM} strokeWidth={STROKE} />
              </button>
            </div>
          )}
          {suggestions.length > 0 && (
            <div className="mention-list" role="listbox" aria-label="People to tag">
              {suggestions.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  className={`mention-item ${i === highlight ? "on" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(p);
                  }}
                >
                  <Avatar id={p.id} name={p.display_name} size={22} />
                  <span className="truncate">{p.display_name}</span>
                </button>
              ))}
            </div>
          )}
          <div className="composer-row">
            <textarea
              ref={ref}
              rows={1}
              value={text}
              maxLength={LIMITS.messageChars}
              placeholder={placeholder}
              aria-label="Message"
              onChange={(e) => {
                setText(e.target.value);
                setCaret(e.target.selectionStart);
                if (e.target.value) onTyping();
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onKeyDown={onKeyDown}
            />
            {showStop ? (
              <button type="button" className="send-btn stop" aria-label="Stop answering" title="Stop" onClick={onStop}>
                <Square size={13} strokeWidth={0} fill="currentColor" aria-hidden />
              </button>
            ) : (
              <button type="button" className="send-btn" aria-label="Send" title="Send" disabled={empty} onClick={submit}>
                <ArrowUp size={ICON} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>
      {warning && <SecretWarning kind={warning.kind} snippet={warning.snippet} onEdit={() => setWarning(null)} onSendAnyway={() => void dispatch(text.trim())} />}
    </div>
  );
}
