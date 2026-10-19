import { MESSAGE_COLUMNS, type ApprovalDoneEvent, type ApprovalEvent, type ChatMessage, type StreamEvent, type TypingEvent } from "@mc/shared";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { notifyChanged } from "../data.tsx";
import { supabase } from "../supabase.ts";
import { OPTIMISTIC_SEQ } from "./Messages.tsx";

/** Newest messages loaded when a chat opens. Older ones are not paged in yet. */
const LOAD_LIMIT = 500;
/** Broadcasts aren't signed and could be oversized; the saved row is the source of truth anyway. */
const MAX_STREAM_CHARS = 200_000;
const TYPING_SHOWN_MS = 4_000;
const TYPING_SEND_EVERY_MS = 2_500;

const bySeq = (a: ChatMessage, b: ChatMessage) => a.seq - b.seq;

/** A change the AI proposed in this chat, as everybody sees it while the answer is being written. */
export type Proposal = ApprovalEvent & { outcome?: ApprovalDoneEvent["outcome"] };

/**
 * Everything live about one open chat: messages (loaded, then kept current by realtime), the text of the answer that is
 * being written, who is online and who is typing, and the read marker the chat had when it was opened.
 */
export function useChatRoom(chatId: string, meId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [streams, setStreams] = useState<Record<string, string>>({});
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  /** undefined until loaded; null when the person never opened this chat before */
  const [readSeq, setReadSeq] = useState<number | null | undefined>(undefined);
  const [live, setLive] = useState(false);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [typingUntil, setTypingUntil] = useState<Record<string, number>>({});
  const channelRef = useRef<RealtimeChannel | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const readSeqLoaded = useRef(false);
  const lastTypingSent = useRef(0);
  const readTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const upsert = useCallback((m: ChatMessage) => {
    setMessages((prev) => {
      const i = prev.findIndex((x) => x.id === m.id);
      const next = i === -1 ? [...prev, m] : prev.map((x, j) => (j === i ? { ...x, ...m } : x));
      return next.sort(bySeq);
    });
  }, []);

  const markRead = useCallback(() => {
    clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      void supabase.rpc("mark_chat_read", { p_chat_id: chatId }).then(({ error }) => !error && notifyChanged());
    }, 500);
  }, [chatId]);

  // Whatever happened while the channel was down is reloaded each time it (re)joins.
  const loadAll = useCallback(async () => {
    const [rows, reads] = await Promise.all([
      supabase.from("messages").select(MESSAGE_COLUMNS).eq("chat_id", chatId).order("seq", { ascending: false }).limit(LOAD_LIMIT),
      readSeqLoaded.current ? null : supabase.from("chat_reads").select("last_seq").eq("chat_id", chatId).eq("user_id", meId).maybeSingle(),
    ]);
    if (!rows.error) {
      const saved = ((rows.data ?? []) as unknown as ChatMessage[]).reverse();
      setMessages((prev) => [...saved, ...prev.filter((m) => m.seq === OPTIMISTIC_SEQ && !saved.some((s) => s.id === m.id))]);
      setLoaded(true);
    }
    if (reads && !readSeqLoaded.current) {
      readSeqLoaded.current = true;
      setReadSeq(reads.data ? Number(reads.data.last_seq) : null);
    }
    markRead();
  }, [chatId, meId, markRead]);

  useEffect(() => {
    const channel = supabase
      .channel(`chat:${chatId}`, { config: { private: true, presence: { key: meId } } })
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` }, (p) => {
        if (p.eventType === "DELETE") {
          const old = p.old as { id?: string };
          if (old.id) setMessages((prev) => prev.filter((m) => m.id !== old.id));
          return;
        }
        const m = p.new as ChatMessage;
        upsert(m);
        if (m.status === "done" || m.status === "error") {
          setStreams(({ [m.id]: _gone, ...rest }) => rest);
          // The answer's own note ("Edited 2 files") replaces the live cards.
          setProposals((cur) => Object.fromEntries(Object.entries(cur).filter(([, p]) => p.messageId !== m.id)));
        }
        const author = m.author_id;
        if (author) setTypingUntil((cur) => Object.fromEntries(Object.entries(cur).filter(([id]) => id !== author)));
        if (m.author_id !== meId) markRead();
      })
      .on("broadcast", { event: "stream" }, ({ payload }) => {
        const e = payload as Partial<StreamEvent>;
        // Any member can broadcast on the channel, so only text for an answer that is really being written is shown.
        const writing = typeof e.messageId === "string" && messagesRef.current.some((m) => m.id === e.messageId && m.role === "assistant" && m.status === "streaming");
        if (writing && typeof e.content === "string") {
          setStreams((s) => ({ ...s, [e.messageId!]: e.content!.slice(0, MAX_STREAM_CHARS) }));
        }
      })
      .on("broadcast", { event: "approval" }, ({ payload }) => {
        // Informational only: anyone in the chat can broadcast, so this shows a card and nothing more. The host decides in their app.
        const e = payload as Partial<ApprovalEvent>;
        const writing = typeof e.messageId === "string" && messagesRef.current.some((m) => m.id === e.messageId && m.role === "assistant" && m.status === "streaming");
        const c = e.change;
        if (writing && c && typeof c.id === "string" && typeof c.path === "string" && typeof c.diff === "string" && typeof e.askedBy === "string") {
          const change = { ...c, path: c.path.slice(0, 400), diff: c.diff.slice(0, 41_000) };
          setProposals((cur) => ({ ...cur, [c.id]: { messageId: e.messageId!, change, askedBy: e.askedBy!.slice(0, 80), readFiles: Number(e.readFiles) || 0 } }));
        }
      })
      .on("broadcast", { event: "approval_done" }, ({ payload }) => {
        const e = payload as Partial<ApprovalDoneEvent>;
        if (typeof e.id === "string" && (e.outcome === "applied" || e.outcome === "denied" || e.outcome === "expired" || e.outcome === "failed")) {
          setProposals((cur) => (cur[e.id!] ? { ...cur, [e.id!]: { ...cur[e.id!]!, outcome: e.outcome } } : cur));
        }
      })
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        const e = payload as Partial<TypingEvent>;
        if (typeof e.userId === "string" && e.userId !== meId) setTypingUntil((t) => ({ ...t, [e.userId!]: Date.now() + TYPING_SHOWN_MS }));
      })
      .on("presence", { event: "sync" }, () => setOnline(new Set(Object.keys(channel.presenceState()))))
      .subscribe((status) => {
        setLive(status === "SUBSCRIBED");
        if (status === "SUBSCRIBED") {
          void channel.track({ at: Date.now() });
          void loadAll();
        }
      });
    channelRef.current = channel;
    const onVisible = () => document.visibilityState === "visible" && markRead();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(readTimer.current);
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [chatId, meId, upsert, loadAll, markRead]);

  // Drop "is typing" hints when they run out.
  useEffect(() => {
    if (Object.keys(typingUntil).length === 0) return;
    const t = setInterval(() => {
      const now = Date.now();
      setTypingUntil((cur) => {
        const next = Object.fromEntries(Object.entries(cur).filter(([, until]) => until > now));
        return Object.keys(next).length === Object.keys(cur).length ? cur : next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [typingUntil]);

  const sendTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingSent.current < TYPING_SEND_EVERY_MS) return;
    lastTypingSent.current = now;
    void channelRef.current?.send({ type: "broadcast", event: "typing", payload: { userId: meId } satisfies TypingEvent });
  }, [meId]);

  const dropOptimistic = useCallback((id: string) => setMessages((prev) => prev.filter((m) => !(m.id === id && m.seq === OPTIMISTIC_SEQ))), []);

  return { messages, loaded, streams, proposals, readSeq, live, online, typingIds: Object.keys(typingUntil), upsert, dropOptimistic, sendTyping };
}
