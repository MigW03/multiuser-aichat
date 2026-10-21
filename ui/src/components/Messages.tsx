import { IMAGE_ONLY_TEXT, isPlanProvider, modelName, PROVIDER_BILLING_URLS, PROVIDER_LABELS, type ChatMessage } from "@mc/shared";
import { Copy, CornerUpLeft, FileText, RotateCcw, Sparkles } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, type ReactNode } from "react";
import { dayLabel, formatTime, sameDay } from "../lib/time.ts";
import { ProposalCards } from "./Changes.tsx";
import { Markdown } from "./Markdown.tsx";
import { PictureGrid } from "./Pictures.tsx";
import { Avatar, Button, AiAvatar, ICON_SM, STROKE } from "./kit.tsx";
import { ANSWER_ATTR, SelectionRespond } from "./SelectionRespond.tsx";
import type { Proposal } from "./useChatRoom.ts";

export const OPTIMISTIC_SEQ = Number.MAX_SAFE_INTEGER;

export type MessageListProps = {
  messages: ChatMessage[];
  streams: Record<string, string>;
  /** changes the AI proposed while the answer is being written, by change id */
  proposals: Record<string, Proposal>;
  meId: string;
  /** id -> display name, for everyone who ever wrote in the chat */
  names: Map<string, string>;
  /** the read marker when the chat was opened; messages after it get the "new" divider */
  readSeq: number | null;
  /** whether the person has any AI key (for the "AI can't answer you yet" card) */
  hasKey: boolean;
  onReply: (m: ChatMessage, quote?: string) => void;
  onRetry: (m: ChatMessage) => void;
  onCopy: (m: ChatMessage) => void;
  /** Present in project chats: saves a message to the project's Notes. */
  onSaveNote?: (m: ChatMessage) => void;
  onAddKey: () => void;
  onUpdateKey: () => void;
  emptyState: ReactNode;
};

/** Highlights @Name for the people the message tagged. */
function withMentions(content: string, mentions: string[], names: Map<string, string>): ReactNode {
  const tagged = mentions.map((id) => names.get(id)).filter((n): n is string => !!n);
  if (tagged.length === 0) return content;
  const escaped = tagged.sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = content.split(new RegExp(`(@(?:${escaped.join("|")}))(?![\\p{L}\\p{N}_])`, "u"));
  return parts.map((part, i) => (i % 2 === 1 ? <span key={i} className="mention">{part}</span> : <Fragment key={i}>{part}</Fragment>));
}

function TypingDots() {
  return (
    <span className="dots" aria-hidden>
      <i />
      <i />
      <i />
    </span>
  );
}

export function MessageList(props: MessageListProps) {
  const { messages, streams, meId, names, readSeq, hasKey } = props;
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const streaming = messages.find((m) => m.role === "assistant" && m.status === "streaming");
  const latestAnswerId = useMemo(() => [...messages].reverse().find((m) => m.role === "assistant" && m.kind !== "summary_request" && (m.status === "done" || m.status === "error"))?.id, [messages]);
  const lastKeylessOwn = useMemo(() => [...messages].reverse().find((m) => m.author_id === meId && m.skip_reason === "no_key")?.id, [messages, meId]);
  const firstUnread = useMemo(() => {
    if (readSeq === null) return null;
    return messages.find((m) => m.seq > readSeq && m.seq !== OPTIMISTIC_SEQ && m.author_id !== meId && m.status !== "pending") ?? null;
  }, [messages, readSeq, meId]);
  const unreadCount = useMemo(
    () => (firstUnread ? messages.filter((m) => m.seq >= firstUnread.seq && m.seq !== OPTIMISTIC_SEQ && m.author_id !== meId && m.kind !== "summary_request" && m.status !== "pending").length : 0),
    [messages, firstUnread, meId],
  );

  // Follow new messages unless the person scrolled up to read.
  useEffect(() => {
    if (pinnedToBottom.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streams]);
  const lastLen = useRef(0);
  useEffect(() => {
    // first render of a chat: jump to the end
    if (messages.length && lastLen.current === 0) bottomRef.current?.scrollIntoView({ block: "end" });
    lastLen.current = messages.length;
  }, [messages.length]);

  const empty = messages.length === 0;

  return (
    <div
      className="messages"
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}
    >
      <div className="messages-col">
        {empty && props.emptyState}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const showDay = !prev || !sameDay(prev.created_at, m.created_at);
          const showUnread = firstUnread?.id === m.id && unreadCount > 0;
          return (
            <Fragment key={m.id}>
              {showDay && m.seq !== OPTIMISTIC_SEQ && (
                <div className="day-divider">
                  <span>{dayLabel(m.created_at)}</span>
                </div>
              )}
              {showUnread && (
                <div className="unread-divider" role="separator">
                  <span>{unreadCount} new since you last read</span>
                </div>
              )}
              <MessageRow
                m={m}
                byId={byId}
                queued={m.status === "pending" && m.author_id === meId}
                streamingText={streams[m.id]}
                answerRunning={!!streaming}
                isLatestAnswer={m.id === latestAnswerId}
                showKeylessCard={m.id === lastKeylessOwn && !hasKey}
                {...props}
              />
            </Fragment>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <SelectionRespond onRespond={(id, quote) => { const m = byId.get(id); if (m) props.onReply(m, quote); }} />
    </div>
  );
}

type RowProps = MessageListProps & {
  m: ChatMessage;
  byId: Map<string, ChatMessage>;
  queued: boolean;
  streamingText?: string;
  answerRunning: boolean;
  isLatestAnswer: boolean;
  showKeylessCard: boolean;
};

function MessageRow(props: RowProps) {
  const { m } = props;
  if (m.role === "assistant") return <AssistantMessage {...props} />;
  if (m.kind === "summary_request") return <SummaryRequest {...props} />;
  return <UserMessage {...props} />;
}

function QuotedReply({ m, byId, names }: Pick<RowProps, "m" | "byId" | "names">) {
  const target = m.reply_to ? byId.get(m.reply_to) : undefined;
  if (!m.reply_to) return null;
  const who = target ? (target.role === "assistant" ? modelName(target.model) : (names.get(target.author_id ?? "") ?? "Someone")) : "an earlier message";
  return (
    <div className="quoted">
      <CornerUpLeft size={12} strokeWidth={STROKE} aria-hidden />
      <span className="truncate">
        <b>{who}</b> {m.meta.quote ? `“${m.meta.quote}”` : target ? (target.content === IMAGE_ONLY_TEXT && target.images.length ? "a picture" : target.content.replace(/\s+/g, " ").slice(0, 90)) : ""}
      </span>
    </div>
  );
}

function UserMessage(props: RowProps) {
  const { m, meId, names, queued, answerRunning, showKeylessCard } = props;
  const own = m.author_id === meId;
  const name = names.get(m.author_id ?? "") ?? "Someone";
  const waiting = queued && answerRunning;
  const pictureOnly = m.images.length > 0 && m.content === IMAGE_ONLY_TEXT;
  const body = pictureOnly ? null : withMentions(m.content, m.mentions, names);
  return (
    <div className={`msg ${own ? "own" : "other"}`}>
      {!own && <Avatar id={m.author_id ?? name} name={name} size={28} />}
      <div className="msg-main">
        {!own && (
          <div className="msg-meta">
            <b>{name}</b> <span className="muted">{formatTime(m.created_at)}</span>
          </div>
        )}
        <QuotedReply m={m} byId={props.byId} names={names} />
        <div className={`bubble ${own ? "own" : "other"} ${waiting ? "queued" : ""} ${m.seq === OPTIMISTIC_SEQ ? "sending" : ""} ${m.images.length ? "has-pics" : ""}`}>
          {m.images.length > 0 && <PictureGrid chatId={m.chat_id} ids={m.images} />}
          {m.images.length > 0 ? body && <div className="pics-text">{body}</div> : body}
        </div>
        {waiting && <div className="msg-note muted">In line · next after this reply</div>}
        {!waiting && m.status === "processing" && own && <div className="msg-note muted">The AI is on it</div>}
        {m.skip_reason === "mention" && <div className="msg-note muted">AI skipped</div>}
        {m.skip_reason === "no_key" && <div className="msg-note muted">People only · no AI key{own ? ". Add a key so the AI can answer you" : ""}</div>}
        {m.status === "error" && <div className="msg-note danger-text">Not answered</div>}
        {showKeylessCard && (
          <div className="inline-card">
            <div>
              <b>The AI can't answer you yet.</b>
              <div className="small muted">Add your own AI key to use it. You can still chat with people.</div>
            </div>
            <Button size="sm" variant="primary" onClick={props.onAddKey}>
              Add a key
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryRequest({ m, names }: RowProps) {
  const name = names.get(m.author_id ?? "") ?? "Someone";
  return (
    <div className="system-line">
      <span>
        {name} asked for a summary
        {m.status === "pending" || m.status === "processing" ? "…" : ""}
      </span>
    </div>
  );
}

function AssistantMessage(props: RowProps) {
  const { m, meId, names, streamingText, isLatestAnswer } = props;
  const asker = names.get(m.for_user_id ?? "") ?? null;
  const owner = m.key_user_id && m.key_user_id !== m.for_user_id ? names.get(m.key_user_id) : null;
  const forMe = m.for_user_id === meId;
  const summary = m.kind === "summary";
  const streaming = m.status === "streaming";
  const text = streaming ? (streamingText ?? m.content) : m.content;
  const failed = m.status === "error";
  const metaParts = [asker ? `for ${forMe ? "you" : asker}` : null, owner ? `${owner}'s key` : null, formatTime(m.created_at)].filter(Boolean);

  return (
    <div className="msg ai">
      <AiAvatar size={28} />
      <div className="msg-main">
        <div className="msg-meta">
          <b className="ai-name">{modelName(m.model)}</b> <span className="muted">{metaParts.join(" · ")}</span>
        </div>
        {failed ? (
          <FailedAnswer {...props} />
        ) : (
          <div className={`bubble ai ${summary ? "summary" : ""}`} {...(streaming ? {} : { [ANSWER_ATTR]: m.id })}>
            {summary && (
              <div className="summary-head">
                <span className="chip accent">Summary</span>
                <span className="small muted">
                  {m.meta.scope === "all" ? `Whole chat · ${m.meta.count ?? ""} messages` : m.meta.count && m.meta.since ? `${m.meta.count} messages since ${dayLabel(m.meta.since).toLowerCase()} ${formatTime(m.meta.since)}` : ""}
                </span>
              </div>
            )}
            {streaming && !text ? (
              <div className="answering">
                <TypingDots />
                <span className="muted small">Answering {forMe ? "you" : (asker ?? "")}</span>
              </div>
            ) : (
              <Markdown text={text} />
            )}
          </div>
        )}
        {streaming && <ProposalCards proposals={Object.values(props.proposals).filter((p) => p.messageId === m.id)} />}
        {!streaming && !failed && (
          <div className={`msg-actions ${isLatestAnswer ? "show" : ""}`}>
            <button type="button" className="act reply" onClick={() => props.onReply(m)}>
              <CornerUpLeft size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Reply
            </button>
            <button type="button" className="act" onClick={() => props.onCopy(m)}>
              <Copy size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Copy
            </button>
            {props.onSaveNote && (
              <button type="button" className="act" onClick={() => props.onSaveNote?.(m)}>
                <FileText size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Save as note
              </button>
            )}
            {forMe && (
              <button type="button" className="act" onClick={() => props.onRetry(m)}>
                <RotateCcw size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FailedAnswer({ m, meId, onRetry, onUpdateKey }: RowProps) {
  const forMe = m.for_user_id === meId;
  const code = m.meta.error;
  const provider = m.provider;
  return (
    <div className="bubble error">
      <div className="error-title">
        <Sparkles size={ICON_SM} strokeWidth={STROKE} aria-hidden />
        {code === "stopped" ? "Stopped" : code === "timeout" ? "The AI took too long to answer" : code === "no_credit" ? `Your ${provider ? PROVIDER_LABELS[provider] : "AI"} account is out of credit` : "The AI couldn't answer"}
      </div>
      <div className="small">{m.content}</div>
      {forMe && (
        <div className="error-actions">
          {code === "invalid_key" && (
            <Button size="sm" variant="primary" onClick={onUpdateKey}>
              {provider && isPlanProvider(provider) ? "Reconnect" : "Update key"}
            </Button>
          )}
          {code === "rate_limit" && provider && isPlanProvider(provider) && (
            <Button size="sm" variant="primary" onClick={onUpdateKey}>
              View plan usage
            </Button>
          )}
          {code === "no_credit" && provider && (
            <a className="btn sm primary" href={PROVIDER_BILLING_URLS[provider]} target="_blank" rel="noopener noreferrer">
              Open console
            </a>
          )}
          <Button size="sm" onClick={() => onRetry(m)}>
            <RotateCcw size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Retry
          </Button>
        </div>
      )}
    </div>
  );
}
