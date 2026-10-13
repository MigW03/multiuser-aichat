"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Markdown } from "@/components/markdown";
import { ModelPicker, type ModelChoice } from "@/components/model-picker";
import type { ProviderId } from "@/lib/ai/provider-meta";

export type ChatMessage = {
  id: string;
  author_id: string | null;
  role: "user" | "assistant";
  content: string;
  status: "pending" | "processing" | "streaming" | "done" | "error";
  seq: number;
  provider: ProviderId | null;
  model: string | null;
};
export type Member = { id: string; display_name: string };

const TYPING_TTL_MS = 3000;
const TYPING_THROTTLE_MS = 1500;

export function ChatRoom(props: {
  chatId: string;
  title: string;
  userId: string;
  initialMessages: ChatMessage[];
  initialMembers: Member[];
  providers: ProviderId[]; // providers this user has saved a key for
  initialChoice: ModelChoice | null;
  initialFavorites: ModelChoice[];
}) {
  const { chatId, userId } = props;
  const supabase = useMemo(() => createClient(), []);
  const [messages, setMessages] = useState(props.initialMessages);
  const [members, setMembers] = useState(props.initialMembers);
  const [providers, setProviders] = useState(props.providers);
  const [choice, setChoice] = useState(props.initialChoice);
  const [favorites, setFavorites] = useState(props.initialFavorites);
  const [streams, setStreams] = useState<Record<string, string>>({}); // messageId -> live text
  const [typing, setTyping] = useState<Record<string, number>>({}); // userId -> last typing timestamp
  const [text, setText] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [title, setTitle] = useState(props.title);
  const [editingTitle, setEditingTitle] = useState(false);
  const [savingTitle, setSavingTitle] = useState<string | null>(null); // new title shown while the save is in flight
  const [titleDraft, setTitleDraft] = useState("");
  const titleEditDone = useRef(true); // Enter, Escape and blur can all end an edit; only the first counts.
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const lastTypingSent = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  const names = useMemo(() => new Map(members.map((m) => [m.id, m.display_name])), [members]);

  const upsert = useCallback((m: ChatMessage) => {
    setMessages((prev) => {
      const i = prev.findIndex((x) => x.id === m.id);
      const next = i === -1 ? [...prev, m] : prev.map((x, j) => (j === i ? { ...x, ...m } : x));
      return next.sort((a, b) => a.seq - b.seq);
    });
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel(`chat:${chatId}`, { config: { private: true } })
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` }, (p) => {
        if (p.eventType === "DELETE") return;
        const m = p.new as ChatMessage;
        upsert(m);
        if (m.status === "done" || m.status === "error") {
          setStreams((s) => {
            if (!(m.id in s)) return s;
            const rest = { ...s };
            delete rest[m.id];
            return rest;
          });
        }
      })
      .on("broadcast", { event: "stream" }, ({ payload }) => {
        setStreams((s) => ({ ...s, [payload.messageId]: payload.content }));
      })
      .on("broadcast", { event: "rename" }, ({ payload }) => {
        if (typeof payload?.title === "string") setTitle(payload.title.slice(0, 80));
      })
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        setTyping((t) => ({ ...t, [payload.userId]: Date.now() }));
      })
      .subscribe();
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [chatId, supabase, upsert]);

  // Keys are added on the Settings page; this re-runs when a kept-alive chat page is shown again.
  useEffect(() => {
    void fetch("/api/keys")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { keys: { provider: ProviderId }[] } | null) => d && setProviders(d.keys.map((k) => k.provider)))
      .catch(() => {});
  }, []);

  // Expire typing indicators.
  useEffect(() => {
    const t = setInterval(() => {
      setTyping((cur) => {
        const now = Date.now();
        const entries = Object.entries(cur).filter(([, at]) => now - at < TYPING_TTL_MS);
        return entries.length === Object.keys(cur).length ? cur : Object.fromEntries(entries);
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Jump straight to the bottom on first paint, then animate for new messages.
  // Next keeps visited pages mounted (hidden) and re-runs their effects when you come back,
  // so the flag is reset on cleanup to treat every revisit as a first paint.
  const didInitialScroll = useRef(false);
  useEffect(() => {
    return () => {
      didInitialScroll.current = false;
    };
  }, []);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: didInitialScroll.current ? "smooth" : "instant" });
    didInitialScroll.current = true;
  }, [messages, streams]);

  function onType(value: string) {
    setText(value);
    const now = Date.now();
    if (value && now - lastTypingSent.current > TYPING_THROTTLE_MS) {
      lastTypingSent.current = now;
      void channelRef.current?.send({ type: "broadcast", event: "typing", payload: { userId } });
    }
  }

  async function chooseModel(next: ModelChoice) {
    const previous = choice;
    setChoice(next);
    // Remembered per chat (and as the default for your next new chat). The query only runs when awaited.
    const { error } = await supabase.rpc("set_chat_model", { p_chat_id: chatId, p_provider: next.provider, p_model: next.model });
    if (error) {
      setChoice(previous);
      setNotice("Could not save your model choice.");
    }
  }

  async function toggleFavorite(fav: ModelChoice) {
    const same = (f: ModelChoice) => f.provider === fav.provider && f.model === fav.model;
    const starred = favorites.some(same);
    setFavorites((cur) => (starred ? cur.filter((f) => !same(f)) : [...cur, fav])); // optimistic
    const table = supabase.from("user_favorite_models");
    const { error } = starred
      ? await table.delete().eq("user_id", userId).eq("provider", fav.provider).eq("model", fav.model)
      : await table.insert({ user_id: userId, provider: fav.provider, model: fav.model });
    if (error) {
      setFavorites((cur) => (starred ? [...cur, fav] : cur.filter((f) => !same(f))));
      setNotice("Could not update your favorites.");
    }
  }

  // A usable choice needs a saved key for its provider (the key may have been removed since it was picked).
  const activeChoice = choice && providers.includes(choice.provider) ? choice : null;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const content = text.trim();
    if (!content) return;
    if (!activeChoice) return setNotice("Choose a model first.");
    setText("");
    setNotice(null);

    // Show the message right away. The id is chosen here and reused by the server, so when the saved row
    // arrives over realtime it replaces this one (and brings the real seq) instead of appearing twice.
    const id = crypto.randomUUID();
    upsert({
      id,
      author_id: userId,
      role: "user",
      content,
      status: "pending",
      seq: Number.MAX_SAFE_INTEGER,
      provider: activeChoice.provider,
      model: activeChoice.model,
    });

    let error = "Could not send your message.";
    try {
      const res = await fetch(`/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, content, provider: activeChoice.provider, model: activeChoice.model }),
      });
      if (res.ok) return;
      error = (await res.json().catch(() => ({}))).error ?? error;
    } catch {
      // network failure: fall through to the rollback below
    }
    setMessages((prev) => prev.filter((m) => m.id !== id));
    setText(content);
    setNotice(error);
  }

  function startRename() {
    setTitleDraft(title);
    titleEditDone.current = false;
    setEditingTitle(true);
  }

  function cancelRename() {
    titleEditDone.current = true;
    setEditingTitle(false);
  }

  async function saveTitle(e?: React.FormEvent) {
    e?.preventDefault();
    if (titleEditDone.current) return;
    titleEditDone.current = true;
    setEditingTitle(false);
    const next = titleDraft.trim();
    if (!next || next === title) return;
    setNotice(null);
    setSavingTitle(next);
    const { data, error } = await supabase.rpc("rename_chat", { p_chat_id: chatId, p_title: next });
    setSavingTitle(null);
    if (error) return setNotice(error.message);
    setTitle(data);
    // Tell the other members; the title isn't a realtime table, so they'd otherwise see the old one until reload.
    void channelRef.current?.send({ type: "broadcast", event: "rename", payload: { title: data } });
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    const { data, error } = await supabase.rpc("invite_to_chat", { p_chat_id: chatId, p_email: inviteEmail });
    if (error) return setNotice(error.message);
    setInviteEmail("");
    setNotice(`${data} was added to the chat.`);
    const { data: rows } = await supabase.from("chat_members").select("profiles(id, display_name)").eq("chat_id", chatId);
    setMembers((rows ?? []).map((r) => r.profiles as unknown as Member).filter(Boolean));
  }

  const typingNames = Object.keys(typing)
    .filter((id) => id !== userId)
    .map((id) => names.get(id) ?? "Someone");
  const aiBusy = messages.some((m) => m.role === "assistant" && m.status === "streaming");

  return (
    <div className="mx-auto flex h-dvh w-full max-w-3xl flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-neutral-200 p-4 dark:border-neutral-800">
        <Link href="/" className="text-sm underline">
          ← Chats
        </Link>
        {editingTitle ? (
          <form onSubmit={saveTitle}>
            <input
              autoFocus
              value={titleDraft}
              maxLength={80}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(e) => e.key === "Escape" && cancelRename()}
              aria-label="Chat title"
              className="w-56 rounded-md border border-neutral-300 bg-transparent px-2 py-1 font-semibold dark:border-neutral-700"
            />
          </form>
        ) : (
          <h1 className="font-semibold">
            <button
              onClick={startRename}
              disabled={savingTitle !== null}
              title="Rename chat"
              className="inline-flex items-center gap-2 rounded px-1 hover:bg-neutral-100 disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-neutral-900"
            >
              {savingTitle ?? title}
              {savingTitle !== null && (
                <span
                  role="status"
                  aria-label="Saving"
                  className="size-3.5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-neutral-700 dark:border-t-neutral-300"
                />
              )}
            </button>
          </h1>
        )}
        <span className="text-sm text-neutral-500">{members.map((m) => m.display_name).join(", ")}</span>
        <form onSubmit={invite} className="ml-auto flex gap-2">
          <input
            type="email"
            required
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="Invite by email"
            className="w-48 rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          />
          <button className="rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700">Invite</button>
        </form>
        {notice && <p className="w-full text-sm text-neutral-500">{notice}</p>}
      </header>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {messages.length === 0 && (
          <div className="m-auto flex max-w-sm flex-col items-center gap-1 text-center">
            <p className="font-medium">No messages yet</p>
            <p className="text-sm text-neutral-500">
              Say something below. Everyone in this chat sees it, and the AI will answer.
            </p>
            {members.length < 2 && (
              <p className="text-sm text-neutral-500">Want company? Invite someone by email from the top right.</p>
            )}
          </div>
        )}
        {messages.map((m) => {
          const mine = m.author_id === userId;
          const content = m.role === "assistant" && m.status === "streaming" ? (streams[m.id] ?? "") : m.content;
          const waiting = m.role === "user" && (m.status === "pending" || m.status === "processing");
          return (
            <div key={m.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
              <span className="mb-1 text-xs text-neutral-500">
                {m.role === "assistant" ? (m.model ? `AI · ${m.model}` : "AI") : mine ? "You" : (names.get(m.author_id ?? "") ?? "Someone")}
              </span>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2 ${m.role === "assistant" ? "" : "whitespace-pre-wrap"} ${
                  m.role === "assistant"
                    ? "bg-neutral-100 dark:bg-neutral-900"
                    : mine
                      ? "bg-foreground text-background"
                      : "bg-blue-100 text-neutral-900 dark:bg-blue-950 dark:text-neutral-100"
                } ${m.status === "error" ? "border border-red-500" : ""}`}
              >
                {m.role === "assistant" ? (
                  content ? <Markdown>{content}</Markdown> : m.status === "streaming" ? "…" : ""
                ) : (
                  content
                )}
              </div>
              {waiting && (
                <span className="mt-1 text-xs text-neutral-500">
                  {m.status === "pending" ? "Waiting in queue…" : "AI is answering…"}
                </span>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="h-5 px-4 text-xs text-neutral-500">
        {typingNames.length > 0 && `${typingNames.join(", ")} ${typingNames.length > 1 ? "are" : "is"} typing…`}
      </div>
      {providers.length === 0 ? (
        <div className="border-t border-neutral-200 p-4 text-sm text-neutral-500 dark:border-neutral-800">
          The AI answers with your own API key.{" "}
          <Link href="/settings" className="underline">
            Add one in Settings
          </Link>{" "}
          to start chatting.
        </div>
      ) : (
        <form onSubmit={send} className="flex flex-col gap-2 border-t border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex justify-end">
            <ModelPicker
              providers={providers}
              value={activeChoice}
              onChange={chooseModel}
              favorites={favorites}
              onToggleFavorite={toggleFavorite}
            />
          </div>
          <div className="flex gap-2">
            <input
              value={text}
              onChange={(e) => onType(e.target.value)}
              placeholder={aiBusy ? "AI is answering — your message will be queued" : "Message everyone and the AI"}
              className="flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
            />
            <button className="rounded-md bg-foreground px-4 py-2 text-background">Send</button>
          </div>
        </form>
      )}
    </div>
  );
}
