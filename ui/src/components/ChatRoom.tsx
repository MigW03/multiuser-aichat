import { LIMITS, isProvider, type Chat, type ChatMessage, type Member, type ModelChoice, type StreamEvent } from "@mc/shared";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api } from "../api.ts";
import { supabase } from "../supabase.ts";
import { Markdown } from "./Markdown.tsx";
import { ModelPicker } from "./ModelPicker.tsx";

const MESSAGE_COLUMNS = "id, chat_id, author_id, role, content, status, seq, provider, model";
/** Sorts after every saved message until the real row (with its seq) arrives. */
const OPTIMISTIC_SEQ = Number.MAX_SAFE_INTEGER;
/** Ignore absurdly large broadcast snapshots; the saved row is the source of truth anyway. */
const MAX_STREAM_CHARS = 200_000;

type Panel = "none" | "rename" | "invite" | "model";

export function ChatRoom(props: { chat: Chat; userId: string; onRenamed: (id: string, title: string) => void }) {
  const { chat, userId, onRenamed } = props;
  const [title, setTitle] = useState(chat.title);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [streams, setStreams] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const [live, setLive] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [panel, setPanel] = useState<Panel>("none");
  const [panelValue, setPanelValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const names = new Map(members.map((m) => [m.id, m.display_name]));
  const memberIds = useRef(new Set<string>());
  memberIds.current = new Set(members.map((m) => m.id));

  const upsert = useCallback((m: ChatMessage) => {
    setMessages((prev) => {
      const i = prev.findIndex((x) => x.id === m.id);
      const next = i === -1 ? [...prev, m] : prev.map((x, j) => (j === i ? { ...x, ...m } : x));
      return next.sort((a, b) => a.seq - b.seq);
    });
  }, []);

  const loadMembers = useCallback(async () => {
    const { data } = await supabase.from("chat_members").select("user_id, ai_provider, ai_model, profiles(id, display_name)").eq("chat_id", chat.id);
    setMembers((data ?? []).map((r) => r.profiles as unknown as Member).filter(Boolean));
    const mine = data?.find((r) => r.user_id === userId);
    if (mine && isProvider(mine.ai_provider) && mine.ai_model) setChoice({ provider: mine.ai_provider, model: mine.ai_model });
  }, [chat.id, userId]);

  // Everything that happened while the channel was down is reloaded on (re)join.
  const loadAll = useCallback(async () => {
    const [{ data }] = await Promise.all([
      supabase.from("messages").select(MESSAGE_COLUMNS).eq("chat_id", chat.id).order("seq"),
      loadMembers(),
    ]);
    setMessages((prev) => [
      ...((data ?? []) as ChatMessage[]),
      ...prev.filter((m) => m.seq === OPTIMISTIC_SEQ && !data?.some((d) => d.id === m.id)),
    ]);
  }, [chat.id, loadMembers]);

  const refreshTitle = useCallback(async () => {
    const { data } = await supabase.from("chats").select("title").eq("id", chat.id).single();
    if (data) {
      setTitle(data.title);
      onRenamed(chat.id, data.title);
    }
  }, [chat.id, onRenamed]);

  useEffect(() => {
    // The fallback model for a chat you haven't picked one in yet: your latest pick anywhere.
    void supabase
      .from("profiles")
      .select("ai_provider, ai_model")
      .eq("id", userId)
      .single()
      .then(({ data }) => {
        if (data && isProvider(data.ai_provider) && data.ai_model) setChoice((cur) => cur ?? { provider: data.ai_provider, model: data.ai_model });
      });
  }, [userId]);

  useEffect(() => {
    const channel = supabase
      .channel(`chat:${chat.id}`, { config: { private: true } })
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `chat_id=eq.${chat.id}` }, (p) => {
        if (p.eventType === "DELETE") return;
        const m = p.new as ChatMessage;
        upsert(m);
        if (m.status === "done" || m.status === "error") {
          setStreams(({ [m.id]: _, ...rest }) => rest);
        }
        if (m.author_id && !memberIds.current.has(m.author_id)) void loadMembers(); // someone new joined
      })
      .on("broadcast", { event: "stream" }, ({ payload }) => {
        const e = payload as Partial<StreamEvent>;
        if (typeof e.messageId === "string" && typeof e.content === "string") {
          setStreams((s) => ({ ...s, [e.messageId!]: e.content!.slice(0, MAX_STREAM_CHARS) }));
        }
      })
      // Broadcasts aren't signed, so a rename event only means "go re-read the title".
      .on("broadcast", { event: "rename" }, () => void refreshTitle())
      .subscribe((status) => {
        setLive(status === "SUBSCRIBED");
        if (status === "SUBSCRIBED") void loadAll();
      });
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [chat.id, upsert, loadAll, loadMembers, refreshTitle]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streams]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const content = text.trim();
    if (!content) return;
    if (!choice) {
      setNotice({ text: "Pick a model first.", error: true });
      return openPanel("model");
    }
    setText("");
    setNotice(null);
    const id = crypto.randomUUID();
    upsert({ id, chat_id: chat.id, author_id: userId, role: "user", content, status: "pending", seq: OPTIMISTIC_SEQ, provider: choice.provider, model: choice.model });
    try {
      await api.sendMessage(chat.id, { id, content, provider: choice.provider, model: choice.model });
    } catch (err) {
      setMessages((prev) => prev.filter((m) => !(m.id === id && m.seq === OPTIMISTIC_SEQ)));
      setText(content);
      setNotice({ text: (err as Error).message, error: true });
    }
  }

  function onComposerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  function openPanel(next: Panel) {
    setPanel((cur) => (cur === next ? "none" : next));
    setPanelValue(next === "rename" ? title : "");
    setNotice(null);
  }

  async function submitPanel(e: FormEvent) {
    e.preventDefault();
    const value = panelValue.trim();
    if (!value || busy) return;
    setBusy(true);
    if (panel === "rename") {
      const { data, error } = await supabase.rpc("rename_chat", { p_chat_id: chat.id, p_title: value });
      if (error) setNotice({ text: error.message, error: true });
      else {
        setTitle(data as string);
        onRenamed(chat.id, data as string);
        void channelRef.current?.send({ type: "broadcast", event: "rename", payload: {} });
        setPanel("none");
      }
    } else if (panel === "invite") {
      const { data, error } = await supabase.rpc("invite_to_chat", { p_chat_id: chat.id, p_email: value });
      if (error) setNotice({ text: error.message, error: true });
      else {
        setNotice({ text: `${data as string} was added to the chat.`, error: false });
        setPanel("none");
        void loadMembers();
      }
    }
    setBusy(false);
  }

  async function chooseModel(next: ModelChoice) {
    const { error } = await supabase.rpc("set_chat_model", { p_chat_id: chat.id, p_provider: next.provider, p_model: next.model });
    if (error) return setNotice({ text: "Could not save your model choice.", error: true });
    setChoice(next);
    setPanel("none");
  }

  return (
    <>
      <header className="chat-header">
        <div className="row grow">
          <div className="subtitle truncate">{title}</div>
          <span className="small muted">{live ? "● Live" : "○ Connecting…"}</span>
        </div>
        <div className="row">
          <button className="btn" onClick={() => openPanel("model")}>{choice ? choice.model : "Pick a model"}</button>
          <button className="btn" onClick={() => openPanel("invite")}>Invite</button>
          <button className="btn" onClick={() => openPanel("rename")}>Rename</button>
        </div>
      </header>

      {panel === "model" && (
        <div className="panel">
          <ModelPicker current={choice} onChoose={chooseModel} onCancel={() => setPanel("none")} />
        </div>
      )}
      {(panel === "rename" || panel === "invite") && (
        <form className="panel" onSubmit={submitPanel}>
          <div className="small muted">{panel === "rename" ? "Rename this chat" : "Add someone who already has an account"}</div>
          <div className="row">
            <input
              className="input"
              autoFocus
              type={panel === "invite" ? "email" : "text"}
              maxLength={panel === "rename" ? LIMITS.titleChars : 254}
              placeholder={panel === "rename" ? "Chat title" : "Their account email"}
              value={panelValue}
              onChange={(e) => setPanelValue(e.target.value)}
            />
            <button className="btn primary" disabled={busy}>{panel === "rename" ? "Save" : "Add"}</button>
            <button type="button" className="btn" onClick={() => setPanel("none")}>Cancel</button>
          </div>
        </form>
      )}

      <div className="messages">
        {messages.length === 0 && <div className="muted">No messages yet. Say hi.</div>}
        {messages.map((m) => {
          const own = m.author_id === userId;
          const ai = m.role === "assistant";
          const author = ai ? `AI${m.model ? ` · ${m.model}` : ""}` : own ? "You" : names.get(m.author_id ?? "") ?? "Someone";
          const body = m.status === "streaming" ? streams[m.id] || "…" : m.content;
          const status =
            m.status === "pending" && own ? "Waiting in queue…" : m.status === "processing" ? "AI is answering…" : m.status === "error" && !ai ? "Not answered" : null;
          return (
            <div key={m.id} className={`message ${own ? "own" : ""} ${ai ? "ai" : ""} ${m.status === "error" && ai ? "error" : ""}`}>
              <div className="small muted">{author}</div>
              <div className={`bubble ${ai ? "rich" : ""}`}>{ai ? <Markdown text={body} /> : body}</div>
              {status && <div className="small muted">{status}</div>}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={send}>
        {notice && <div className={`small ${notice.error ? "danger" : "success"}`}>{notice.text}</div>}
        <textarea
          className="input"
          rows={2}
          maxLength={LIMITS.messageChars}
          placeholder="Message the chat… (Enter to send, Shift+Enter for a new line)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onComposerKey}
        />
      </form>
    </>
  );
}
