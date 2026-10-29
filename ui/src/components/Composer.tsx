import { answerPreview, designChipLabel, IMAGE_LIMITS, IMAGE_ONLY_TEXT, isSmartModel, LIMITS, type ChatMessage, type DesignRef, type ModelChoice, type Person, type Reasoning } from "@mc/shared";
import { ArrowUp, CornerUpLeft, Image as ImageIcon, Plus, Shapes, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { findSecret, maskSecret } from "../lib/secrets.ts";
import { SecretWarning } from "./Dialogs.tsx";
import { IMAGE_ACCEPT, preparePicture, type Picture } from "../lib/images.ts";
import { useModelReasoning, useModelVision } from "../lib/models.ts";
import { MarkdownBackdrop } from "./MarkdownBackdrop.tsx";
import { ModelPicker, ReasoningPicker } from "./Pickers.tsx";
import { UsageRing } from "./PlanUsage.tsx";
import { Avatar, ICON, ICON_SM, Menu, STROKE } from "./kit.tsx";

export type OutgoingMessage = { content: string; mentions: string[]; replyTo: string | null; quote: string | null; pictures: Picture[] };

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
  /** Resolves false when sending failed, so the text and pictures can be put back. */
  onSend: (m: OutgoingMessage) => Promise<boolean>;
  placeholder: string;
  focusKey: string;
  /** Small line on the left above the input, e.g. who is typing. */
  status?: ReactNode;
  /** Text to put in the box, ready to send or change: a click in a generated answer. `key` changes for each new draft. */
  draft?: { text: string; key: number } | null;
  /**
   * In a project that shares a folder: what the next message is about on the design side (the open design, the layers
   * picked with "Ask AI", or a request for a new design), shown as a chip; "+" can ask for a design.
   */
  design?: { chip: DesignRef | null; onClear: () => void; onNew: () => void; onOpen: (path: string) => void };
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** People whose "@Name" appears in the text as a whole word. Editing the @ out of the text un-tags them. */
export function mentionedIn(text: string, people: Person[]): string[] {
  return people
    .filter((p) => new RegExp(`(^|\\s)@${escapeRe(p.display_name)}(?![\\p{L}\\p{N}_])`, "u").test(text))
    .map((p) => p.id);
}

export function Composer({ people, choice, onModel, onReasoning, replyTo, onClearReply, canStop, onStop, onTyping, onSend, placeholder, focusKey, status, draft, design }: Props) {
  const thinking = useModelReasoning(choice);
  const vision = useModelVision(choice);
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [warning, setWarning] = useState<{ kind: string; snippet: string } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const backdrop = useRef<HTMLDivElement>(null);

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

  // A click in a generated answer drafts a reply: it replaces what was typed, and the caret goes to the end.
  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    pendingCaret.current = draft.text.length;
  }, [draft?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Grow with the text, up to about eight lines.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    syncBackdrop();
  }, [text]);

  // The styled copy scrolls along with the textarea.
  function syncBackdrop() {
    if (backdrop.current && ref.current) backdrop.current.style.transform = `translateY(${-ref.current.scrollTop}px)`;
  }

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

  const noVision = vision === false;

  /** Adds picked, pasted or dropped files. Says why in one line when some are left out. */
  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    if (noVision) return setNotice("This model doesn't support images.");
    const room = IMAGE_LIMITS.perMessage - pictures.length;
    if (room <= 0) return setNotice(`You can attach up to ${IMAGE_LIMITS.perMessage} pictures.`);
    const results = await Promise.allSettled(files.slice(0, room).map(preparePicture));
    const added = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    setPictures((cur) => {
      const fit = added.slice(0, Math.max(0, IMAGE_LIMITS.perMessage - cur.length));
      for (const p of added.slice(fit.length)) URL.revokeObjectURL(p.url);
      return [...cur, ...fit];
    });
    setNotice(failed ? (failed.reason instanceof Error ? failed.reason.message : "That file could not be added.") : files.length > room ? `You can attach up to ${IMAGE_LIMITS.perMessage} pictures.` : null);
    ref.current?.focus();
  }

  function removePicture(id: string) {
    setPictures((cur) => {
      const gone = cur.find((p) => p.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return cur.filter((p) => p.id !== id);
    });
    setNotice(null);
  }

  // Dropping files anywhere on the window attaches them; the whole window shows the drop zone while they are dragged over it.
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  useEffect(() => {
    let depth = 0;
    const withFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!withFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!withFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => withFiles(e) && e.preventDefault(); // without this the browser would open the file instead
    const drop = (e: DragEvent) => {
      if (!withFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      void addFilesRef.current([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  async function dispatch(content: string) {
    const sending = pictures;
    const outgoing: OutgoingMessage = { content, mentions: mentionedIn(content, people), replyTo: replyTo?.message.id ?? null, quote: replyTo?.quote ?? null, pictures: sending };
    setText("");
    setPictures([]);
    setNotice(null);
    setWarning(null);
    const ok = await onSend(outgoing);
    if (!ok) {
      setText((cur) => (cur ? cur : content));
      setPictures((cur) => (cur.length ? cur : sending));
    }
  }

  function submit() {
    const content = text.trim();
    if (!content && pictures.length === 0) return;
    if (noVision && pictures.length > 0) return;
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

  const empty = text.trim().length === 0 && pictures.length === 0;
  const blocked = noVision && pictures.length > 0;
  // While an answer is written the button is Stop; once the person types it is Send again and the message queues.
  const showStop = canStop && empty;

  return (
    <div className="composer-wrap">
      <div className="composer-col">
        <div className="composer-top">
          {status}
          <span className="grow" />
          <UsageRing provider={choice?.provider ?? null} answering={canStop} />
          <ModelPicker choice={choice} onChoose={onModel} />
          <ReasoningPicker levels={thinking.levels} value={thinking.effective} onChange={onReasoning} disabled={!choice} auto={isSmartModel(choice?.model)} />
        </div>
        <div className="composer">
          {replyTo && (
            <div className="reply-strip">
              <CornerUpLeft size={ICON_SM} strokeWidth={STROKE} aria-hidden />
              <span className="truncate">
                Replying to <b>{replyTo.who}</b> · {replyTo.quote ? `“${replyTo.quote}”` : replyTo.message.content === IMAGE_ONLY_TEXT ? "a picture" : answerPreview(replyTo.message.content).replace(/\s+/g, " ").slice(0, 100)}
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
                  <Avatar id={p.id} name={p.display_name} src={p.avatar_url} size={22} />
                  <span className="truncate">{p.display_name}</span>
                </button>
              ))}
            </div>
          )}
          {design?.chip && (
            <div className="design-strip">
              <button type="button" className={`design-chip ${design.chip.sel?.length ? "picked" : ""}`} title={design.chip.path ?? "A new design"} onClick={() => design.chip?.path && design.onOpen(design.chip.path)}>
                <Shapes size={ICON_SM} strokeWidth={STROKE} aria-hidden />
                <span className="truncate">{designChipLabel(design.chip)}</span>
              </button>
              <span className="small muted truncate">{design.chip.action === "new" ? "The AI draws a design from your message" : design.chip.sel?.length ? "The AI changes only these layers" : "Your message is about this design"}</span>
              <button type="button" className="icon-btn" aria-label="Don't send this with the message" onClick={design.onClear}>
                <X size={ICON_SM} strokeWidth={STROKE} />
              </button>
            </div>
          )}
          {pictures.length > 0 && (
            <div className="composer-pics">
              {pictures.map((p) => (
                <div key={p.id} className="composer-pic">
                  <img src={p.url} alt={p.name} draggable={false} />
                  <button type="button" className="pic-remove" aria-label={`Remove ${p.name}`} onClick={() => removePicture(p.id)}>
                    <X size={12} strokeWidth={2.2} />
                  </button>
                </div>
              ))}
              {pictures.length < IMAGE_LIMITS.perMessage && !noVision && (
                <button type="button" className="composer-pic add" aria-label="Add another picture" onClick={() => fileInput.current?.click()}>
                  <Plus size={ICON} strokeWidth={STROKE} />
                </button>
              )}
            </div>
          )}
          {(blocked || notice) && (
            <div className="composer-notice" role="status">
              {blocked ? "This model doesn't support images. Remove them or pick another model." : notice}
            </div>
          )}
          <div className="composer-row">
            {design ? (
              <Menu
                label="Add to the message"
                placement="above"
                items={[
                  { label: "Picture", icon: <ImageIcon size={ICON_SM} strokeWidth={STROKE} />, disabled: noVision || pictures.length >= IMAGE_LIMITS.perMessage, ...(noVision ? { hint: "This model doesn't support images" } : {}), onSelect: () => fileInput.current?.click() },
                  { label: "Design", icon: <Shapes size={ICON_SM} strokeWidth={STROKE} />, hint: "The AI answers with a design", onSelect: design.onNew },
                ]}
                trigger={({ toggle, open }) => (
                  <button type="button" className={`icon-btn attach-btn ${open ? "active" : ""}`} aria-label="Add to the message" aria-haspopup="menu" aria-expanded={open} title="Add a picture or ask for a design" onClick={toggle}>
                    <Plus size={ICON} strokeWidth={STROKE} />
                  </button>
                )}
              />
            ) : (
              <button
                type="button"
                className="icon-btn attach-btn"
                aria-label="Attach pictures"
                title={noVision ? "This model doesn't support images" : "Attach pictures"}
                disabled={noVision || pictures.length >= IMAGE_LIMITS.perMessage}
                onClick={() => fileInput.current?.click()}
              >
                <Plus size={ICON} strokeWidth={STROKE} />
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple
              accept={IMAGE_ACCEPT}
              aria-hidden
              tabIndex={-1}
              onChange={(e) => {
                void addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <div className="composer-input">
              <textarea
                ref={ref}
                className="md-live"
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
                onScroll={syncBackdrop}
                onPaste={(e) => {
                  // A copied picture (a screenshot) attaches; copied text, even with a picture beside it, pastes as text.
                  const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
                  if (files.length > 0 && !e.clipboardData.getData("text/plain")) {
                    e.preventDefault();
                    void addFiles(files);
                  }
                }}
              />
              <MarkdownBackdrop text={text} innerRef={backdrop} />
            </div>
            {showStop ? (
              <button type="button" className="send-btn stop" aria-label="Stop answering" title="Stop" onClick={onStop}>
                <Square size={13} strokeWidth={0} fill="currentColor" aria-hidden />
              </button>
            ) : (
              <button type="button" className="send-btn" aria-label="Send" title="Send" disabled={empty || blocked} onClick={submit}>
                <ArrowUp size={ICON} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>
      {dragging && (
        <div className="drop-zone" aria-hidden>
          <span>Drop pictures to attach</span>
        </div>
      )}
      {warning && <SecretWarning kind={warning.kind} snippet={warning.snippet} onEdit={() => setWarning(null)} onSendAnyway={() => void dispatch(text.trim())} />}
    </div>
  );
}
