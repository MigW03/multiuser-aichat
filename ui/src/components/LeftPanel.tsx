import { canManagePeople, LIMITS, ROLE_LABELS, type ChatSummary, type ProjectMember, type ProjectSummary } from "@mc/shared";
import { ChevronLeft, ChevronRight, KeyRound, Link2, LogOut, MessageSquarePlus, MoreHorizontal, PanelLeftClose, Pencil, Pin, PinOff, Plus, Search, Settings, Trash2, UserPlus, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { APP_NAME } from "../config.ts";
import { notifyChanged, useApp } from "../data.tsx";
import { setPinned } from "../lib/actions.ts";
import { PREF, readPref, writePref } from "../lib/prefs.ts";
import { navigate, openProjectSettings } from "../lib/router.ts";
import { listTime } from "../lib/time.ts";
import { supabase } from "../supabase.ts";
import { BrandMark } from "./Auth.tsx";
import {
  CreateProjectDialog,
  DeleteChatDialog,
  DeleteProjectDialog,
  JoinWithLinkDialog,
  MembersDialog,
  RenameDialog,
} from "./Dialogs.tsx";
import { ProjectTile } from "./Join.tsx";
import { PANEL_SHORTCUT } from "../lib/shortcuts.ts";
import { Avatar, Button, IconButton, ICON, ICON_SM, Menu, SectionLabel, STROKE, UnreadBadge } from "./kit.tsx";

type Props = {
  /** The project being viewed, or null on the home screen. */
  project: ProjectSummary | null;
  projects: ProjectSummary[] | undefined;
  chats: ChatSummary[] | undefined;
  members: ProjectMember[] | undefined;
  online: Set<string>;
  activeChatId: string | null;
  onCollapse: () => void;
  /** Called after the person picks something, so a drawer on a small screen can close. */
  onNavigate: () => void;
};

type RowDialog = { kind: "rename" | "delete"; chat: ChatSummary } | null;

export function LeftPanel({ project, projects, chats, members, online, activeChatId, onCollapse, onNavigate }: Props) {
  const { me, openInvite } = useApp();
  const [query, setQuery] = useState("");
  const [rowDialog, setRowDialog] = useState<RowDialog>(null);
  const [dialog, setDialog] = useState<"create" | "join" | "members" | "rename-project" | "delete-project" | null>(null);

  const q = query.trim().toLowerCase();
  const titleMatches = useMemo(() => (chats ?? []).filter((c) => !q || c.title.toLowerCase().includes(q)), [chats, q]);
  const hits = useMessageSearch(query, project?.id ?? null);

  function go(route: Parameters<typeof navigate>[0]) {
    navigate(route);
    onNavigate();
  }

  const newChat = () => go(project ? { name: "project", projectId: project.id, chatId: null, draft: true } : { name: "home" });
  const openChat = (c: ChatSummary) => go(project ? { name: "project", projectId: project.id, chatId: c.id } : { name: "homeChat", chatId: c.id });
  const titleOf = new Map((chats ?? []).map((c) => [c.id, c.title]));

  return (
    <aside className="left-panel" aria-label={project ? `${project.name} chats` : "Chats and projects"}>
      <div className="panel-top">
        {project ? (
          <button type="button" className="back-btn" onClick={() => go({ name: "home" })}>
            <ChevronLeft size={ICON} strokeWidth={STROKE} aria-hidden /> All projects
          </button>
        ) : (
          <div className="brand">
            <BrandMark small />
            <span className="brand-name">{APP_NAME}</span>
          </div>
        )}
        <IconButton label="Hide panel" shortcut={PANEL_SHORTCUT} onClick={onCollapse}>
          <PanelLeftClose size={ICON} strokeWidth={STROKE} />
        </IconButton>
      </div>

      {project && (
        <div className="project-head">
          <ProjectTile name={project.name} size={32} />
          <div className="grow">
            <div className="project-name truncate">{project.name}</div>
            <div className="small muted">{ROLE_LABELS[project.my_role]}</div>
          </div>
          <Menu
            label="Project options"
            align="end"
            items={[
              { label: "People", icon: <Users size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => setDialog("members") },
              { label: "Project settings", icon: <Settings size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => openProjectSettings(project.id) },
              ...(canManagePeople(project.my_role) ? [{ label: "Rename project", icon: <Pencil size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => setDialog("rename-project") }] : []),
              ...(project.my_role === "host" ? ["divider" as const, { label: "Delete project", danger: true, icon: <Trash2 size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => setDialog("delete-project") }] : []),
            ]}
            trigger={({ toggle, open }) => (
              <IconButton label="Project options" onClick={toggle} active={open} aria-haspopup="menu" aria-expanded={open}>
                <MoreHorizontal size={ICON} strokeWidth={STROKE} />
              </IconButton>
            )}
          />
        </div>
      )}

      <div className="panel-actions">
        <Button variant="primary" block onClick={newChat}>
          <MessageSquarePlus size={ICON} strokeWidth={STROKE} aria-hidden /> New chat
        </Button>
        <label className="search-field">
          <Search size={ICON_SM} strokeWidth={STROKE} aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={project ? "Search this project" : "Search your chats"} aria-label="Search" />
          {query && (
            <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => setQuery("")}>
              <X size={ICON_SM} strokeWidth={STROKE} />
            </button>
          )}
        </label>
      </div>

      <div className="panel-scroll">
        {!project && !q && (
          <section>
            <SectionLabel
              action={
                <button type="button" className="icon-btn" aria-label="New project" title="New project" onClick={() => setDialog("create")}>
                  <Plus size={ICON_SM} strokeWidth={STROKE} />
                </button>
              }
            >
              Projects
            </SectionLabel>
            {projects === undefined ? null : projects.length === 0 ? (
              <div className="panel-empty">
                <p className="small muted">Projects are shared spaces for up to {LIMITS.maxPeople} people.</p>
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <Button size="sm" onClick={() => setDialog("create")}>
                    <Plus size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Create project
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDialog("join")}>
                    <Link2 size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Join with a link
                  </Button>
                </div>
              </div>
            ) : (
              <ul className="rows">
                {projects.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="row-item" onClick={() => go({ name: "project", projectId: p.id, chatId: null })}>
                      <ProjectTile name={p.name} size={28} />
                      <span className="grow">
                        <span className="row-title truncate block">{p.name}</span>
                        <span className="small muted">
                          {p.member_count} {p.member_count === 1 ? "person" : "people"}
                        </span>
                      </span>
                      <UnreadBadge people={p.unread_people} ai={p.unread_ai} />
                      <ChevronRight size={ICON_SM} strokeWidth={STROKE} className="muted" aria-hidden />
                    </button>
                  </li>
                ))}
                <li>
                  <button type="button" className="row-item subtle" onClick={() => setDialog("join")}>
                    <Link2 size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Join with a link
                  </button>
                </li>
              </ul>
            )}
          </section>
        )}

        <section>
          <SectionLabel>{project ? "Chats" : "Your chats"}</SectionLabel>
          {chats === undefined ? null : titleMatches.length === 0 ? (
            <p className="panel-empty small muted">{q ? "No chats match." : project ? "No chats yet. Start the first one." : "No chats yet."}</p>
          ) : (
            <ul className="rows">
              {titleMatches.map((c) => (
                <ChatRow key={c.id} chat={c} active={c.id === activeChatId} meId={me.id} onOpen={() => openChat(c)} onRename={() => setRowDialog({ kind: "rename", chat: c })} onDelete={() => setRowDialog({ kind: "delete", chat: c })} canDelete={c.created_by === me.id || canManagePeople(project?.my_role)} />
              ))}
            </ul>
          )}
        </section>

        {hits.length > 0 && (
          <section>
            <SectionLabel>In messages</SectionLabel>
            <ul className="rows">
              {hits.map((h) => (
                <li key={h.message_id}>
                  <button type="button" className="row-item" onClick={() => go(project ? { name: "project", projectId: project.id, chatId: h.chat_id } : { name: "homeChat", chatId: h.chat_id })}>
                    <span className="grow">
                      <span className="row-title truncate block">{titleOf.get(h.chat_id) ?? "Chat"}</span>
                      <span className="small muted clamp2">{h.snippet}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {project && members && <PeopleCard project={project} members={members} online={online} onManage={() => setDialog("members")} />}
      <AccountCard />

      {rowDialog?.kind === "rename" && (
        <RenameDialog
          title="Rename chat"
          label="Chat name"
          initial={rowDialog.chat.title}
          max={LIMITS.titleChars}
          onClose={() => setRowDialog(null)}
          onSave={async (title) => {
            await api.renameChat(rowDialog.chat.id, title);
            notifyChanged();
          }}
        />
      )}
      {rowDialog?.kind === "delete" && (
        <DeleteChatDialog
          chatId={rowDialog.chat.id}
          title={rowDialog.chat.title}
          onClose={() => setRowDialog(null)}
          onDeleted={() => {
            if (rowDialog.chat.id === activeChatId) navigate(project ? { name: "project", projectId: project.id, chatId: null } : { name: "home" }, { replace: true });
          }}
        />
      )}
      {dialog === "create" && <CreateProjectDialog onClose={() => setDialog(null)} />}
      {dialog === "join" && <JoinWithLinkDialog onClose={() => setDialog(null)} />}
      {dialog === "members" && project && members && <MembersDialog project={project} members={members} online={online} onInvite={() => openInvite({ kind: "project", projectId: project.id })} onClose={() => setDialog(null)} />}
      {dialog === "rename-project" && project && (
        <RenameDialog
          title="Rename project"
          label="Project name"
          initial={project.name}
          max={LIMITS.projectNameChars}
          onClose={() => setDialog(null)}
          onSave={async (name) => {
            await api.renameProject(project.id, name);
            notifyChanged();
          }}
        />
      )}
      {dialog === "delete-project" && project && <DeleteProjectDialog project={project} onClose={() => setDialog(null)} />}
    </aside>
  );
}

function useMessageSearch(query: string, projectId: string | null) {
  const [hits, setHits] = useState<{ chat_id: string; message_id: string; snippet: string }[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void supabase.rpc("search_messages", { p_query: q, p_project: projectId }).then(({ data, error }) => {
        if (live) setHits(error ? [] : ((data ?? []) as { chat_id: string; message_id: string; snippet: string }[]));
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, projectId]);
  return hits;
}

function ChatRow({ chat, active, meId, canDelete, onOpen, onRename, onDelete }: { chat: ChatSummary; active: boolean; meId: string; canDelete: boolean; onOpen: () => void; onRename: () => void; onDelete: () => void }) {
  const unread = chat.unread_people + chat.unread_ai;
  const prefix = chat.preview_role === "assistant" ? "AI: " : chat.preview_author === meId && chat.member_count !== 1 ? "You: " : "";
  const shared = chat.member_count > 1;
  return (
    <li className={`chat-row ${active ? "active" : ""}`}>
      <button type="button" className="row-item" onClick={onOpen} aria-current={active ? "page" : undefined}>
        <span className="grow">
          <span className={`row-title truncate block ${unread > 0 && !active ? "strong" : ""}`}>
            {chat.pinned && <Pin size={11} strokeWidth={2} className="pin-mark" aria-label="Pinned" />}
            {shared && <Users size={12} strokeWidth={STROKE} className="group-mark" aria-label="Shared chat" />}
            {chat.title}
          </span>
          <span className="small muted truncate block">{chat.preview ? `${prefix}${chat.preview.replace(/\s+/g, " ")}` : "No messages yet"}</span>
        </span>
        <span className="row-meta">
          <span className="small muted">{listTime(chat.last_message_at)}</span>
          {!active && <UnreadBadge people={chat.unread_people} ai={chat.unread_ai} />}
        </span>
      </button>
      <Menu
        label={`Options for ${chat.title}`}
        align="end"
        className="row-menu"
        items={[
          { label: chat.pinned ? "Unpin" : "Pin to top", icon: chat.pinned ? <PinOff size={ICON_SM} strokeWidth={STROKE} /> : <Pin size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => void setPinned(chat.id, meId, !chat.pinned) },
          { label: "Rename", icon: <Pencil size={ICON_SM} strokeWidth={STROKE} />, onSelect: onRename },
          ...(canDelete ? ["divider" as const, { label: "Delete", danger: true, icon: <Trash2 size={ICON_SM} strokeWidth={STROKE} />, onSelect: onDelete }] : []),
        ]}
        trigger={({ toggle, open }) => (
          <button type="button" className={`icon-btn row-more ${open ? "open" : ""}`} aria-label={`Options for ${chat.title}`} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
            <MoreHorizontal size={ICON_SM} strokeWidth={STROKE} />
          </button>
        )}
      />
    </li>
  );
}

function PeopleCard({ project, members, online, onManage }: { project: ProjectSummary; members: ProjectMember[]; online: Set<string>; onManage: () => void }) {
  const { me, openInvite } = useApp();
  // Collapsed by default: avatars and an Invite button. The person's choice is remembered.
  const [open, setOpen] = useState(() => readPref(PREF.peopleOpen(me.id), false));
  const manage = canManagePeople(project.my_role);
  const toggle = () => {
    setOpen((o) => {
      writePref(PREF.peopleOpen(me.id), !o);
      return !o;
    });
  };
  return (
    <div className="people-card">
      <div className="people-head">
        <button type="button" className="people-toggle" onClick={toggle} aria-expanded={open}>
          <ChevronRight size={ICON_SM} strokeWidth={STROKE} className={open ? "turn" : ""} aria-hidden />
          <span className="section-text">People · {members.length}</span>
        </button>
        {manage && (
          <Button size="sm" variant="ghost" onClick={() => openInvite({ kind: "project", projectId: project.id })}>
            <UserPlus size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Invite
          </Button>
        )}
      </div>
      {open ? (
        <ul className="people-rows">
          {members.map((m) => (
            <li key={m.id}>
              <Avatar id={m.id} name={m.display_name} size={24} online={online.has(m.id)} />
              <span className="grow truncate">
                {m.display_name}
                {m.id === me.id && <span className="muted"> (you)</span>}
              </span>
              <span className="small muted">{ROLE_LABELS[m.role]}</span>
            </li>
          ))}
          <li>
            <Button size="sm" variant="ghost" onClick={onManage}>
              Manage people
            </Button>
          </li>
        </ul>
      ) : (
        <button type="button" className="people-avatars" onClick={toggle} aria-label="Show people">
          {members.slice(0, 6).map((m) => (
            <Avatar key={m.id} id={m.id} name={m.display_name} size={24} online={online.has(m.id)} ring />
          ))}
          {members.length > 6 && <span className="small muted">+{members.length - 6}</span>}
        </button>
      )}
    </div>
  );
}

function AccountCard() {
  const { me, openSettings } = useApp();
  return (
    <div className="account-card">
      <Menu
        label="Account"
        placement="above"
        align="start"
        width={220}
        className="account-menu"
        items={[
          { label: "Settings", icon: <Settings size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => openSettings("account") },
          { label: "AI key", icon: <KeyRound size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => openSettings("key") },
          "divider",
          { label: "Log out", icon: <LogOut size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => void supabase.auth.signOut() },
        ]}
        trigger={({ toggle, open }) => (
          <button type="button" className="account-btn" onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
            <Avatar id={me.id} name={me.display_name} size={30} />
            <span className="grow">
              <span className="row-title truncate block">{me.display_name}</span>
              <span className="small muted truncate block">{me.email}</span>
            </span>
            <Settings size={ICON_SM} strokeWidth={STROKE} className="muted" aria-hidden />
          </button>
        )}
      />
    </div>
  );
}
