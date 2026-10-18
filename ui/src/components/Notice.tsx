import { Eye, EyeOff, ShieldAlert, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, ICON, STROKE } from "./kit.tsx";

// The "who can see this" notices. They are shown in a dialog of their own when joining, and swapped into the invite
// dialog (never a dialog on top of a dialog) when inviting.

type Item = { icon: ReactNode; title: string; text: string };

export type NoticeProps = {
  title: string;
  items: Item[];
  confirmLabel: string;
  cancelLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (neverShowAgain: boolean) => void;
  onCancel: () => void;
};

export function NoticeBody({ title, items, confirmLabel, cancelLabel, busy, error, onConfirm, onCancel }: NoticeProps) {
  const [never, setNever] = useState(false);
  return (
    <>
      <div>
        <h2 className="dialog-title flush">{title}</h2>
        <p className="small muted notice-sub">This shows once, unless you turn it off.</p>
      </div>
      <ul className="notice-list">
        {items.map((item) => (
          <li key={item.title}>
            <span className="notice-icon" aria-hidden>
              {item.icon}
            </span>
            <div>
              <div className="notice-title">{item.title}</div>
              <div className="small muted">{item.text}</div>
            </div>
          </li>
        ))}
      </ul>
      <label className="check">
        <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />
        Never show this again
      </label>
      {error ? <div className="error-line">{error}</div> : null}
      <div className="notice-actions">
        <Button onClick={onCancel}>{cancelLabel}</Button>
        <Button variant="primary" busy={busy} onClick={() => onConfirm(never)}>
          {confirmLabel}
        </Button>
      </div>
    </>
  );
}

const claudeItem: Item = {
  icon: <Sparkles size={ICON} strokeWidth={STROKE} />,
  title: "The AI reads the messages too",
  text: "Replies run on a member's AI key, so the text goes to that key's provider.",
};
const secretsItem: Item = {
  icon: <ShieldAlert size={ICON} strokeWidth={STROKE} />,
  title: "Keep secrets out",
  text: "Don't paste passwords or private keys. Use Your chats for things only you should see.",
};

const seePeople = (names: string[]) => (names.length === 1 ? names[0]! : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.length} people`);

/** Before inviting someone into a project. */
export const inviteProjectNotice = (invitee: string, project: string): Pick<NoticeProps, "title" | "items"> => ({
  title: `Before you invite ${invitee}`,
  items: [
    { icon: <Eye size={ICON} strokeWidth={STROKE} />, title: `${invitee} will see every chat in ${project}`, text: "That includes past messages, and so does everyone already in the project." },
    claudeItem,
    secretsItem,
  ],
});

/** Before inviting someone into one of your own chats. */
export const inviteChatNotice = (invitee: string, chat: string, others: string[]): Pick<NoticeProps, "title" | "items"> => ({
  title: `Before you invite ${invitee}`,
  items: [
    { icon: <Eye size={ICON} strokeWidth={STROKE} />, title: `${invitee} will see every message in ${chat}`, text: `That includes past messages, and so do ${others.length ? seePeople(others) : "you"} and anyone else in the chat.` },
    claudeItem,
    { icon: <EyeOff size={ICON} strokeWidth={STROKE} />, title: "Your other chats stay private", text: `${invitee} only gets this chat. Nothing else in Your chats is shared.` },
  ],
});

/** Before accepting an invite to a project. */
export const joinProjectNotice = (project: string, alreadyIn: number): Pick<NoticeProps, "title" | "items"> => ({
  title: `Before you join ${project}`,
  items: [
    { icon: <Eye size={ICON} strokeWidth={STROKE} />, title: "You will see every chat in this project", text: `That includes past messages, and so do the ${alreadyIn} ${alreadyIn === 1 ? "person" : "people"} already in it.` },
    claudeItem,
    secretsItem,
  ],
});

/** Before accepting an invite to a shared chat. */
export const joinChatNotice = (chat: string, alreadyIn: number): Pick<NoticeProps, "title" | "items"> => ({
  title: `Before you join ${chat}`,
  items: [
    { icon: <Eye size={ICON} strokeWidth={STROKE} />, title: "You will see every message in this chat", text: `That includes past messages, and so do the ${alreadyIn} ${alreadyIn === 1 ? "person" : "people"} already in it.` },
    claudeItem,
    secretsItem,
  ],
});
