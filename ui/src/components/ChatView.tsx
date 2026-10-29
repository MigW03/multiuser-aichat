import { DEFAULT_CHAT_TITLE, DEFAULT_REASONING, IMAGE_ONLY_TEXT, isSmartModel, LIMITS, NOTE_LIMITS, canManagePeople, modelName, type ChatMessage, type ChatSummary, type Person, type ProjectSummary, type Reasoning, type ModelChoice } from "@mc/shared";
import { Link2, Monitor, MoreHorizontal, PanelLeftOpen, Pencil, Pin, PinOff, Shapes, Sparkles, Trash2, UserPlus, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { fetchChatPeople, notifyChanged, useApp, useLive } from "../data.tsx";
import { copyText, setPinned } from "../lib/actions.ts";
import { setChatSender } from "../lib/designBus.ts";
import { setDraftTarget } from "../lib/drafts.ts";
import { uploadPictures } from "../lib/images.ts";
import { useModelReasoning } from "../lib/models.ts";
import { navigate } from "../lib/router.ts";
import { shareBaseUrl } from "../config.ts";
import { supabase } from "../supabase.ts";
import { Composer, type OutgoingMessage, type ReplyTarget } from "./Composer.tsx";
import { DeleteChatDialog, RenameDialog, SummarizeDialog } from "./Dialogs.tsx";
import { EmptyChat } from "./EmptyStates.tsx";
import { RightPanelToggle } from "./FolderUi.tsx";
import { MessageList, OPTIMISTIC_SEQ } from "./Messages.tsx";
import { noteTitleFrom } from "./NotesUi.tsx";
import { PANEL_SHORTCUT } from "../lib/shortcuts.ts";
import { Avatar, IconButton, ICON, ICON_SM, Menu, STROKE, useToast } from "./kit.tsx";
import { useChatRoom } from "./useChatRoom.ts";

type Props = {
  chat: ChatSummary;
  project: ProjectSummary | null;
  /** The project's people when this is a project chat. */
  projectPeople: Person[] | undefined;
  projectOnline: Set<string>;
  /** The left panel is hidden: show a button to bring it back. */
  leftCollapsed: boolean;
  onShowLeft: () => void;
};

function typingText(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.length} people are typing…`;
}

export function ChatView({ chat, project, projectPeople, projectOnline, leftCollapsed, onShowLeft }: Props) {
  const { me, keys, choice, setChoice, openAddKey, openSettings, openInvite, preview, design } = useApp();
  const thinking = useModelReasoning(choice);
  const toast = useToast();
  const room = useChatRoom(chat.id, me.id);
  const homePeople = useLive(() => (project ? Promise.resolve([] as Person[]) : fetchChatPeople(chat.id)), [chat.id, project?.id]);
  const people: Person[] = project ? (projectPeople ?? []) : (homePeople.data ?? [{ id: me.id, display_name: me.display_name, avatar_url: me.avatar_url }]);
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const [draft, setDraft] = useState<{ text: string; key: number } | null>(null);
  const [dialog, setDialog] = useState<"rename" | "delete" | "summarize" | null>(null);
  const [extraNames, setExtraNames] = useState<Map<string, string>>(new Map());
  const [extraAvatars, setExtraAvatars] = useState<Map<string, string | null>>(new Map());
  const asked = useRef(new Set<string>());

  const names = useMemo(() => {
    const map = new Map(extraNames);
    for (const p of people) map.set(p.id, p.display_name);
    map.set(me.id, me.display_name);
    return map;
  }, [extraNames, people, me]);

  const avatars = useMemo(() => {
    const map = new Map(extraAvatars);
    for (const p of people) map.set(p.id, p.avatar_url ?? null);
    map.set(me.id, me.avatar_url);
    return map;
  }, [extraAvatars, people, me]);

  // Authors who left the project still show under their name.
  useEffect(() => {
    const missing = new Set<string>();
    for (const m of room.messages) {
      for (const id of [m.author_id, m.for_user_id, m.key_user_id, ...m.mentions]) {
        if (id && !names.has(id) && !asked.current.has(id)) missing.add(id);
      }
    }
    if (missing.size === 0) return;
    missing.forEach((id) => asked.current.add(id));
    void supabase
      .from("profiles")
      .select("id, display_name, avatar_url")
      .in("id", [...missing])
      .then(({ data }) => {
        if (!data) return;
        setExtraNames((prev) => new Map([...prev, ...data.map((d) => [d.id, d.display_name] as const)]));
        setExtraAvatars((prev) => new Map([...prev, ...data.map((d) => [d.id, d.avatar_url as string | null] as const)]));
      });
  }, [room.messages, names]);

  const others = people.filter((p) => p.id !== me.id);
  const shared = project ? people.length > 1 : chat.member_count > 1;
  const manage = project ? canManagePeople(project.my_role) : false;
  const canDelete = chat.created_by === me.id || manage;
  const hasKey = (keys?.length ?? 0) > 0;
  const hasUnread = room.readSeq !== undefined && room.readSeq !== null && room.messages.some((m) => m.seq > room.readSeq! && m.seq !== OPTIMISTIC_SEQ && m.author_id !== me.id && m.status !== "pending" && m.kind !== "summary_request");
  const canStop = room.messages.some((m) => (m.role === "assistant" && m.status === "streaming" && m.for_user_id === me.id) || (m.author_id === me.id && m.status === "processing"));
  const typing = typingText(room.typingIds.map((id) => names.get(id)).filter((n): n is string => !!n));
  const doneCount = room.messages.filter((m) => m.status === "done" && m.kind !== "summary_request").length;

  async function send(out: OutgoingMessage, raw = false): Promise<boolean> {
    // In a project, a message about a design starts with its marker (the open design, the layers picked, canvas edits).
    const marker = project && !raw ? design.take() : null;
    if (marker) out = { ...out, content: `${marker}\n${out.content}`.slice(0, LIMITS.messageChars) };
    const id = crypto.randomUUID();
    // With Auto the chosen model uses its own default thinking, so no level is sent.
    const reasoning = choice && isSmartModel(choice.model) ? null : thinking.effective;
    const answered = !!choice && out.mentions.length === 0;
    room.upsert({
      id,
      chat_id: chat.id,
      author_id: me.id,
      role: "user",
      kind: "message",
      content: out.content || IMAGE_ONLY_TEXT,
      images: out.pictures.map((p) => p.id),
      status: answered ? "pending" : "done",
      seq: OPTIMISTIC_SEQ,
      created_at: new Date().toISOString(),
      provider: choice?.provider ?? null,
      model: choice?.model ?? null,
      reasoning,
      reply_to: out.replyTo,
      mentions: out.mentions,
      skip_reason: null,
      for_user_id: null,
      key_user_id: null,
      run_id: null,
      meta: out.quote ? { quote: out.quote } : {},
    });
    setReply(null);
    try {
      await uploadPictures(chat.id, out.pictures);
      await api.sendMessage(chat.id, {
        id,
        content: out.content,
        ...(out.pictures.length ? { images: out.pictures.map((p) => p.id) } : {}),
        ...(choice ? { provider: choice.provider, model: choice.model, ...(reasoning ? { reasoning } : {}) } : {}),
        mentions: out.mentions,
        ...(out.replyTo ? { replyTo: out.replyTo, ...(out.quote ? { quote: out.quote } : {}) } : {}),
      });
      return true;
    } catch (e) {
      room.dropOptimistic(id);
      toast.push(e instanceof Error ? e.message : "Could not send the message.", "error");
      return false;
    }
  }

  async function retry(m: ChatMessage) {
    try {
      await api.retry(m.id);
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Could not retry.", "error");
    }
  }

  async function copy(m: ChatMessage) {
    if (m.content === IMAGE_ONLY_TEXT && m.images.length) return toast.push("This message has no text to copy", "info");
    toast.push((await copyText(m.content)) ? "Copied" : "Could not copy", "info");
  }

  async function saveNote(m: ChatMessage) {
    if (!project) return;
    try {
      // Saved with a quick title; the server has the AI title it from the question and the answer, with this person's model.
      await api.addNote(project.id, { title: noteTitleFrom(m.content), body: m.content.slice(0, NOTE_LIMITS.bodyChars), fromMessage: m.id, ...(choice ? { provider: choice.provider, model: choice.model } : {}) });
      notifyChanged();
      toast.push("Saved to Notes");
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Could not save the note.", "error");
    }
  }

  function replyTo(m: ChatMessage, quote?: string) {
    setReply({ message: m, who: m.role === "assistant" ? modelName(m.model) : (names.get(m.author_id ?? "") ?? "Someone"), ...(quote ? { quote } : {}) });
  }

  // A click in a note's generated UI drafts a message here, in the chat that is open.
  useEffect(() => setDraftTarget((text) => setDraft((d) => ({ text, key: (d?.key ?? 0) + 1 }))), []);
  // The design panel's "Build in code" and "Update code" are messages sent here (they carry their own marker).
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => (project ? setChatSender((content) => sendRef.current({ content, mentions: [], replyTo: null, quote: null, pictures: [] }, true)) : undefined), [project]);

  /** A click in an answer's generated UI: a reply to that answer, drafted in the composer for the person to send or change. */
  function draftReply(m: ChatMessage, text: string) {
    replyTo(m);
    setDraft((d) => ({ text, key: (d?.key ?? 0) + 1 }));
  }

  const pickModel = (c: Pick<ModelChoice, "provider" | "model">) => setChoice({ ...c, reasoning: choice?.reasoning ?? DEFAULT_REASONING });
  const pickReasoning = (r: Reasoning) => choice && setChoice({ ...choice, reasoning: r });

  const menuItems = [
    { label: chat.pinned ? "Unpin" : "Pin to top", icon: chat.pinned ? <PinOff size={ICON_SM} strokeWidth={STROKE} /> : <Pin size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => void setPinned(chat.id, me.id, !chat.pinned) },
    { label: "Rename", icon: <Pencil size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => setDialog("rename") },
    ...(!project ? [{ label: "Invite someone", icon: <UserPlus size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => openInvite({ kind: "chat", chatId: chat.id }) }] : []),
    ...(project
      ? [{ label: "Copy link to chat", icon: <Link2 size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => void copyText(`${shareBaseUrl()}#/p/${project.id}/c/${chat.id}`).then((ok) => toast.push(ok ? "Link copied" : "Could not copy")) }]
      : []),
    ...(canDelete ? ["divider" as const, { label: "Delete chat", danger: true, icon: <Trash2 size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => setDialog("delete") }] : []),
  ];

  return (
    <section className="chat-card" aria-label={chat.title}>
      <header className="chat-header">
        {leftCollapsed && (
          <IconButton label="Show chats" shortcut={PANEL_SHORTCUT} onClick={onShowLeft}>
            <PanelLeftOpen size={ICON} strokeWidth={STROKE} />
          </IconButton>
        )}
        <div className="chat-title">
          <h1 className={`truncate ${chat.title === DEFAULT_CHAT_TITLE ? "unnamed" : ""}`}>{chat.title}</h1>
          {shared && (
            <span className="group-chip" title={project ? "Shared with the project" : "Shared chat"}>
              <Users size={ICON_SM} strokeWidth={STROKE} aria-hidden />
              {people.length}
            </span>
          )}
        </div>
        <div className="grow" />
        {shared && !project && (
          <span className="header-people" aria-label="People in this chat">
            {people.slice(0, 5).map((p) => (
              <Avatar key={p.id} id={p.id} name={p.display_name} src={p.avatar_url} size={26} online={(project ? projectOnline : room.online).has(p.id)} ring />
            ))}
          </span>
        )}
        {!project && (
          <IconButton label="Invite someone to this chat" onClick={() => openInvite({ kind: "chat", chatId: chat.id })}>
            <UserPlus size={ICON} strokeWidth={STROKE} />
          </IconButton>
        )}
        {project && design.available && (
          <button type="button" className={`btn sm ${design.path ? "active" : ""}`} aria-pressed={!!design.path} onClick={() => (design.path ? design.close() : design.pick())} title="Designs (⌘K)">
            <Shapes size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Design
          </button>
        )}
        {preview.available && (
          <button type="button" className={`btn sm ${preview.open ? "active" : ""}`} aria-pressed={preview.open} onClick={() => (preview.open ? preview.close() : preview.show())} title="Preview a web page from this computer">
            <Monitor size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Preview
          </button>
        )}
        <button type="button" className="btn sm" onClick={() => setDialog("summarize")} disabled={doneCount < 2}>
          <Sparkles size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Summarize
        </button>
        <Menu
          label="Chat options"
          align="end"
          items={menuItems}
          trigger={({ toggle, open }) => (
            <IconButton label="Chat options" onClick={toggle} active={open} aria-haspopup="menu" aria-expanded={open}>
              <MoreHorizontal size={ICON} strokeWidth={STROKE} />
            </IconButton>
          )}
        />
        {project && <RightPanelToggle />}
      </header>

      <MessageList
        messages={room.messages}
        streams={room.streams}
        proposals={room.proposals}
        meId={me.id}
        names={names}
        avatars={avatars}
        readSeq={room.readSeq ?? null}
        hasKey={hasKey}
        onReply={replyTo}
        onRetry={(m) => void retry(m)}
        onCopy={(m) => void copy(m)}
        {...(project ? { onSaveNote: (m: ChatMessage) => void saveNote(m) } : {})}
        onAddKey={openAddKey}
        onUpdateKey={() => openSettings("key")}
        onDraft={draftReply}
        emptyState={room.loaded ? <EmptyChat shared={shared} hasKey={hasKey} onAddKey={openAddKey} /> : null}
      />

      <Composer
        people={others}
        choice={choice}
        onModel={pickModel}
        onReasoning={pickReasoning}
        replyTo={reply}
        onClearReply={() => setReply(null)}
        canStop={canStop}
        onStop={() => void api.stop(chat.id).catch(() => undefined)}
        onTyping={shared ? room.sendTyping : () => undefined}
        onSend={send}
        placeholder={shared ? "Message the chat. Tag someone with @ to talk to them, not the AI." : choice ? `Message ${modelName(choice.model)}` : "Message the AI"}
        focusKey={chat.id}
        status={typing ? <span className="typing-line small muted">{typing}</span> : null}
        draft={draft}
        {...(project && design.available
          ? {
              design: {
                chip: design.chip,
                onClear: () => design.setChip(null),
                onNew: () => design.setChip({ action: "new" }),
                onOpen: (path: string) => design.open(path),
              },
            }
          : {})}
      />

      {dialog === "rename" && (
        <RenameDialog
          title="Rename chat"
          label="Chat name"
          initial={chat.title}
          max={LIMITS.titleChars}
          onClose={() => setDialog(null)}
          onSave={async (title) => {
            await api.renameChat(chat.id, title);
            notifyChanged();
          }}
        />
      )}
      {dialog === "delete" && (
        <DeleteChatDialog
          chatId={chat.id}
          title={chat.title}
          onClose={() => setDialog(null)}
          onDeleted={() => navigate(project ? { name: "project", projectId: project.id, chatId: null } : { name: "home" }, { replace: true })}
        />
      )}
      {dialog === "summarize" && <SummarizeDialog chatId={chat.id} choice={choice} readSeq={room.readSeq ?? null} hasUnread={hasUnread} onClose={() => setDialog(null)} />}
    </section>
  );
}
