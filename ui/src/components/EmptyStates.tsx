import { DEFAULT_REASONING, modelName, type ModelChoice, type Person, type ProjectSummary, type Reasoning } from "@mc/shared";
import { Check, KeyRound, MessageSquarePlus, PanelLeftOpen, Sparkles, Users } from "lucide-react";
import { RightPanelToggle } from "./FolderUi.tsx";
import { useRef } from "react";
import { api } from "../api.ts";
import { notifyChanged, useApp } from "../data.tsx";
import { uploadPictures } from "../lib/images.ts";
import { greeting } from "../lib/time.ts";
import { useModelReasoning } from "../lib/models.ts";
import { navigate } from "../lib/router.ts";
import { Composer, type OutgoingMessage } from "./Composer.tsx";
import { PANEL_SHORTCUT } from "../lib/shortcuts.ts";
import { Button, IconButton, ICON, ICON_SM, STROKE, useToast } from "./kit.tsx";

/** Shown in a chat with no messages yet. */
export function EmptyChat({ shared, hasKey, onAddKey }: { shared: boolean; hasKey: boolean; onAddKey: () => void }) {
  return (
    <div className="empty-chat">
      <span className="empty-icon" aria-hidden>
        <Sparkles size={22} strokeWidth={STROKE} />
      </span>
      <h2>{shared ? "Say hi to the team" : "Ask the AI anything"}</h2>
      <p className="muted">
        {shared
          ? "The AI answers every message unless you tag a person with @. Then it stays quiet and the message is just for them."
          : "Write a message below. The AI answers right away."}
      </p>
      {!hasKey && (
        <Button variant="primary" onClick={onAddKey}>
          <KeyRound size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Add your AI key
        </Button>
      )}
    </div>
  );
}

function Checklist({ hasKey, hasChat, hasProject }: { hasKey: boolean; hasChat: boolean; hasProject: boolean }) {
  const { openAddKey } = useApp();
  const steps = [
    { done: hasKey, title: "Add your AI key", text: "The AI answers with your own account.", action: hasKey ? null : <Button size="sm" variant="primary" onClick={openAddKey}>Add key</Button> },
    { done: hasChat, title: "Send your first message", text: "Type below. Nobody else sees a chat in Your chats unless you invite them." },
    { done: hasProject, title: "Create a project for your team", text: "Shared chats for up to 10 people." },
  ];
  if (steps.every((s) => s.done)) return null;
  return (
    <div className="checklist" aria-label="Getting set up">
      <div className="section-label">
        <span>Getting set up</span>
        <span>
          {steps.filter((s) => s.done).length} of {steps.length}
        </span>
      </div>
      <ul>
        {steps.map((s) => (
          <li key={s.title} className={s.done ? "done" : ""}>
            <span className="check-dot" aria-hidden>
              {s.done && <Check size={11} strokeWidth={3} />}
            </span>
            <div className="grow">
              <b>{s.title}</b>
              <div className="small muted">{s.text}</div>
            </div>
            {s.action}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A chat that does not exist yet. The first message creates it, so "New chat" never leaves empty chats behind.
 * Home (projectId null) starts a private chat; inside a project it starts a chat everyone in the project can see.
 */
export function Landing({
  project,
  people,
  hasChat,
  hasProject,
  leftCollapsed,
  onShowLeft,
}: {
  project: ProjectSummary | null;
  people: Person[];
  hasChat: boolean;
  hasProject: boolean;
  leftCollapsed: boolean;
  onShowLeft: () => void;
}) {
  const { me, keys, choice, setChoice, openAddKey } = useApp();
  const thinking = useModelReasoning(choice);
  const toast = useToast();
  const created = useRef<string | null>(null);
  const hasKey = (keys?.length ?? 0) > 0;
  const first = me.display_name.split(/\s+/)[0] ?? "";

  async function send(out: OutgoingMessage): Promise<boolean> {
    try {
      // If the chat was created but the message failed, the next try reuses that chat.
      const chatId = created.current ?? (await api.createChat(project?.id ?? null)).id;
      created.current = chatId;
      await uploadPictures(chatId, out.pictures);
      await api.sendMessage(chatId, {
        id: crypto.randomUUID(),
        content: out.content,
        ...(out.pictures.length ? { images: out.pictures.map((p) => p.id) } : {}),
        ...(choice ? { provider: choice.provider, model: choice.model, ...(thinking.effective ? { reasoning: thinking.effective } : {}) } : {}),
        mentions: out.mentions,
      });
      notifyChanged();
      navigate(project ? { name: "project", projectId: project.id, chatId } : { name: "homeChat", chatId });
      return true;
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Could not send the message.", "error");
      return false;
    }
  }

  const pickModel = (c: Pick<ModelChoice, "provider" | "model">) => setChoice({ ...c, reasoning: choice?.reasoning ?? DEFAULT_REASONING });
  const pickReasoning = (r: Reasoning) => choice && setChoice({ ...choice, reasoning: r });

  return (
    <section className="chat-card landing" aria-label="New chat">
      <header className="chat-header">
        {leftCollapsed && (
          <IconButton label="Show chats" shortcut={PANEL_SHORTCUT} onClick={onShowLeft}>
            <PanelLeftOpen size={ICON} strokeWidth={STROKE} />
          </IconButton>
        )}
        <div className="chat-title">
          <h1 className="truncate">{project ? project.name : "New chat"}</h1>
          {project && (
            <span className="group-chip">
              <Users size={ICON_SM} strokeWidth={STROKE} aria-hidden />
              {project.member_count}
            </span>
          )}
        </div>
        {project && (
          <>
            <div className="grow" />
            <RightPanelToggle />
          </>
        )}
      </header>
      <div className="landing-body">
        <div className="landing-col">
          <span className="empty-icon" aria-hidden>
            <MessageSquarePlus size={22} strokeWidth={STROKE} />
          </span>
          <h2>
            {greeting()}
            {first ? `, ${first}` : ""}
          </h2>
          <p className="muted">
            {project ? `Start a chat in ${project.name}. Everyone in the project can see it.` : "Start a chat. Only you and the AI see it until you invite someone."}
          </p>
          {!hasKey && keys && (
            <div className="inline-card">
              <div>
                <b>Add your AI key to use the AI.</b>
                <div className="small muted">Without one you can still chat with people.</div>
              </div>
              <Button size="sm" variant="primary" onClick={openAddKey}>
                Add a key
              </Button>
            </div>
          )}
          {!project && <Checklist hasKey={hasKey} hasChat={hasChat} hasProject={hasProject} />}
        </div>
      </div>
      <Composer
        people={people.filter((p) => p.id !== me.id)}
        choice={choice}
        onModel={pickModel}
        onReasoning={pickReasoning}
        replyTo={null}
        onClearReply={() => undefined}
        canStop={false}
        onStop={() => undefined}
        onTyping={() => undefined}
        onSend={send}
        placeholder={project ? "Write the first message" : choice ? `Message ${modelName(choice.model)}` : "Message the AI"}
        focusKey={project?.id ?? "home"}
      />
    </section>
  );
}
