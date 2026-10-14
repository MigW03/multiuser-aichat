import type { Chat } from "@mc/shared";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabase.ts";
import { ChatRoom } from "./ChatRoom.tsx";
import { Settings } from "./Settings.tsx";

/** Chat list on the left; the open chat or the API keys page on the right. */
export function Shell({ userId }: { userId: string }) {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [name, setName] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: rows, error: chatsError }, { data: me }] = await Promise.all([
      supabase.from("chats").select("id, title, created_at").order("created_at", { ascending: false }),
      supabase.from("profiles").select("display_name").eq("id", userId).single(),
    ]);
    if (chatsError) return setError("Could not load your chats.");
    setChats(rows ?? []);
    setName(me?.display_name ?? "");
    setOpenId((cur) => cur ?? rows?.[0]?.id ?? null);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function newChat() {
    const { data, error: rpcError } = await supabase.rpc("create_chat", { p_title: "New chat" });
    if (rpcError || !data) return setError("Could not create a chat.");
    await load();
    setOpenId(data as string);
    setShowSettings(false);
  }

  const renamed = useCallback((id: string, title: string) => {
    setChats((cur) => cur?.map((c) => (c.id === id ? { ...c, title } : c)) ?? cur);
  }, []);

  const open = chats?.find((c) => c.id === openId);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="row">
          <div className="subtitle grow">Chats</div>
          <button className="btn primary" onClick={newChat}>New chat</button>
        </div>
        <nav className="chat-list">
          {chats?.map((c) => (
            <button
              key={c.id}
              className={`chat-item truncate ${c.id === openId && !showSettings ? "selected" : ""}`}
              onClick={() => {
                setOpenId(c.id);
                setShowSettings(false);
              }}
            >
              {c.title}
            </button>
          ))}
          {chats?.length === 0 && <div className="muted">No chats yet.</div>}
        </nav>
        {error && <div className="danger small">{error}</div>}
        <div className="row">
          <div className="muted truncate grow">{name}</div>
          <button className={`btn ${showSettings ? "primary" : ""}`} onClick={() => setShowSettings((s) => !s)}>API keys</button>
          <button className="btn" onClick={() => void supabase.auth.signOut()}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        {showSettings ? (
          <Settings />
        ) : open ? (
          <ChatRoom key={open.id} chat={open} userId={userId} onRenamed={renamed} />
        ) : (
          <div className="center muted">{chats ? "Pick a chat or create one." : "Loading…"}</div>
        )}
      </main>
    </div>
  );
}
