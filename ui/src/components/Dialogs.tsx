import {
  ASSIGNABLE_ROLES,
  canManagePeople,
  LIMITS,
  modelLabel,
  PROVIDER_LABELS,
  ROLE_LABELS,
  type AssignableRole,
  type ModelChoice,
  type ProjectMember,
  type ProjectSummary,
  type SummaryScope,
} from "@mc/shared";
import { Check, ChevronDown, Copy, LogOut, ShieldAlert, Sparkles, UserMinus } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type InviteCreated, type InviteRow } from "../api.ts";
import { notifyChanged, useApp, useLive } from "../data.tsx";
import { copyText } from "../lib/actions.ts";
import { PREF, readPref, writePref } from "../lib/prefs.ts";
import { navigate, tokenFromPasted } from "../lib/router.ts";
import { expiresIn } from "../lib/time.ts";
import { inviteChatNotice, inviteProjectNotice, NoticeBody } from "./Notice.tsx";
import { Avatar, Button, Dialog, ErrorLine, Field, ICON_SM, Menu, STROKE, TextInput, useToast } from "./kit.tsx";
import { modelButtonLabel } from "./Pickers.tsx";

const messageOf = (e: unknown, fallback = "Something went wrong. Try again.") => (e instanceof Error && e.message ? e.message : fallback);

// ------------------------------------------------------------------ small generic dialogs

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} busy={busy} onClick={() => void run()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="lead">{children}</div>
      <ErrorLine>{error}</ErrorLine>
    </Dialog>
  );
}

export function RenameDialog({ title, label, initial, max, onSave, onClose }: { title: string; label: string; initial: string; max: number; onSave: (value: string) => Promise<void>; onClose: () => void }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!v) return setError("Enter a name.");
    setBusy(true);
    try {
      await onSave(v);
      onClose();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }
  return (
    <Dialog title={title} onClose={onClose}>
      <form className="col" style={{ gap: 16 }} onSubmit={submit}>
        <Field label={label} htmlFor="rename-input">
          <TextInput id="rename-input" value={value} maxLength={max} onChange={(e) => setValue(e.target.value)} data-autofocus />
        </Field>
        <ErrorLine>{error}</ErrorLine>
        <div className="dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function SecretWarning({ kind, snippet, onEdit, onSendAnyway }: { kind: string; snippet: string; onEdit: () => void; onSendAnyway: () => void }) {
  return (
    <Dialog
      onClose={onEdit}
      label="This looks like a secret"
      width={440}
      footer={
        <>
          <Button onClick={onSendAnyway}>Send anyway</Button>
          <Button variant="primary" onClick={onEdit}>
            Edit message
          </Button>
        </>
      }
    >
      <div className="notice-head">
        <span className="notice-icon warn" aria-hidden>
          <ShieldAlert size={18} strokeWidth={STROKE} />
        </span>
        <h2 className="dialog-title flush">This looks like a {kind}</h2>
      </div>
      <code className="secret-snippet">{snippet}</code>
      <p className="lead">Everyone in this chat can read it, and so can Claude and the AI provider behind it. Share passwords and keys another way.</p>
    </Dialog>
  );
}

export function CreateProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the project a name.");
    setBusy(true);
    try {
      const { id } = await api.createProject(name.trim());
      notifyChanged();
      onClose();
      navigate({ name: "project", projectId: id, chatId: null, draft: true });
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }
  return (
    <Dialog title="New project" onClose={onClose}>
      <form className="col" style={{ gap: 16 }} onSubmit={submit}>
        <p className="lead">A project holds shared chats for the people you invite. You can invite up to {LIMITS.maxPeople - 1} others.</p>
        <Field label="Project name" htmlFor="project-name">
          <TextInput id="project-name" value={name} maxLength={LIMITS.projectNameChars} onChange={(e) => setName(e.target.value)} placeholder="Launch plan" data-autofocus />
        </Field>
        <ErrorLine>{error}</ErrorLine>
        <div className="dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>
            Create project
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function JoinWithLinkDialog({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const token = tokenFromPasted(value);
    if (!token) return setError("That doesn't look like an invite link.");
    onClose();
    navigate({ name: "join", token });
  }
  return (
    <Dialog title="Join with a link" onClose={onClose}>
      <form className="col" style={{ gap: 16 }} onSubmit={submit}>
        <Field label="Invite link" htmlFor="join-link" hint="Paste the link you were sent.">
          <TextInput id="join-link" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://…/#/join/…" data-autofocus />
        </Field>
        <ErrorLine>{error}</ErrorLine>
        <div className="dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary">
            Continue
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ invites

function InviteList({ invites, onChanged }: { invites: InviteRow[]; onChanged: () => void }) {
  const toast = useToast();
  async function copy(link: string) {
    toast.push((await copyText(link)) ? "Invite link copied" : "Could not copy. Select the link and copy it.", "info");
  }
  async function revoke(id: string) {
    try {
      await api.revokeInvite(id);
      onChanged();
    } catch (e) {
      toast.push(messageOf(e), "error");
    }
  }
  if (invites.length === 0) return null;
  return (
    <div className="pending">
      <div className="section-label">
        <span>Pending invites</span>
      </div>
      <ul className="pending-list">
        {invites.map((i) => (
          <li key={i.id}>
            <div className="grow">
              <div className="truncate">{i.email}</div>
              <div className="small muted">
                {i.role === "admin" ? "Admin · " : ""}
                {expiresIn(i.expires_at)}
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void copy(i.link)}>
              <Copy size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Copy link
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void revoke(i.id)}>
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type InviteTarget = { kind: "project"; projectId: string; name: string } | { kind: "chat"; chatId: string; name: string; others: string[] };

export function InviteDialog({ target, onClose }: { target: InviteTarget; onClose: () => void }) {
  const { me } = useApp();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("member");
  const [step, setStep] = useState<"form" | "notice" | "done">("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ email: string; result: InviteCreated } | null>(null);
  const targetId = target.kind === "project" ? target.projectId : target.chatId;
  const invites = useLive(() => (target.kind === "project" ? api.projectInvites(target.projectId) : api.chatInvites(target.chatId)).then((r) => r.invites), [targetId]);

  async function send() {
    const address = email.trim();
    setBusy(true);
    setError(null);
    try {
      const result = target.kind === "project" ? await api.inviteToProject(target.projectId, address, role) : await api.inviteToChat(target.chatId, address);
      setCreated({ email: address, result });
      setStep("done");
      setEmail("");
      invites.reload();
    } catch (e) {
      setError(messageOf(e));
      setStep("form");
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError("Enter a full email address.");
    setError(null);
    if (readPref(PREF.hideInviteNotice(me.id), false)) void send();
    else setStep("notice");
  }

  // The "who can see this" notice replaces the form inside the same dialog; it never opens on top of it.
  if (step === "notice") {
    const notice = target.kind === "project" ? inviteProjectNotice(email.trim(), target.name) : inviteChatNotice(email.trim(), target.name, target.others);
    return (
      <Dialog onClose={onClose} width={460} label="Before you invite">
        <NoticeBody
          {...notice}
          confirmLabel="Send invite"
          cancelLabel="Back"
          busy={busy}
          error={error}
          onCancel={() => setStep("form")}
          onConfirm={(never) => {
            if (never) writePref(PREF.hideInviteNotice(me.id), true);
            void send();
          }}
        />
      </Dialog>
    );
  }

  if (step === "done" && created) {
    return (
      <Dialog title={created.result.emailed ? "Invite sent" : "Invite ready"} onClose={onClose}>
        <p className="lead">
          {created.result.emailed ? (
            <>
              We emailed <b className="strong">{created.email}</b>. The link works for {LIMITS.inviteDays} days and only for that address.
            </>
          ) : (
            <>
              Email isn't set up on this server, so nothing was sent. Copy the link and send it to <b className="strong">{created.email}</b> yourself. It works for {LIMITS.inviteDays} days and only for that address.
            </>
          )}
        </p>
        <div className="link-box">
          <code className="truncate">{created.result.link}</code>
          <Button
            size="sm"
            onClick={async () => toast.push((await copyText(created.result.link)) ? "Invite link copied" : "Could not copy. Select the link and copy it.")}
          >
            <Copy size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Copy
          </Button>
        </div>
        <div className="dialog-actions">
          <Button onClick={() => setStep("form")}>Invite someone else</Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={`Invite to ${target.name}`} onClose={onClose} width={480}>
      <form className="col" style={{ gap: 16 }} onSubmit={submit} noValidate>
        <p className="lead">
          {target.kind === "project"
            ? `They get a link by email. Up to ${LIMITS.maxPeople} people per project. Pending invites count.`
            : `They only get this chat. Up to ${LIMITS.maxPeople} people per chat. Pending invites count.`}
        </p>
        <Field label="Email" htmlFor="invite-email" hint="The link only works with this address.">
          <TextInput id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoComplete="off" data-autofocus />
        </Field>
        {target.kind === "project" && (
          <Field label="Role">
            <div className="segmented" role="radiogroup" aria-label="Role">
              {ASSIGNABLE_ROLES.map((r) => (
                <button key={r} type="button" role="radio" aria-checked={role === r} className={`seg ${role === r ? "on" : ""}`} onClick={() => setRole(r)}>
                  {ROLE_LABELS[r]}
                </button>
              ))}
            </div>
          </Field>
        )}
        <ErrorLine>{error}</ErrorLine>
        <div className="dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary">
            Send invite
          </Button>
        </div>
      </form>
      {invites.data && <InviteList invites={invites.data} onChanged={invites.reload} />}
    </Dialog>
  );
}

// ------------------------------------------------------------------ people

export function MembersDialog({
  project,
  members,
  online,
  onInvite,
  onClose,
}: {
  project: ProjectSummary;
  members: ProjectMember[];
  online: Set<string>;
  onInvite: () => void;
  onClose: () => void;
}) {
  const { me } = useApp();
  const toast = useToast();
  const manage = canManagePeople(project.my_role);
  const [confirm, setConfirm] = useState<ProjectMember | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasKey, setHasKey] = useState<Record<string, boolean>>({});
  const invites = useLive(() => (manage ? api.projectInvites(project.id).then((r) => r.invites) : Promise.resolve([] as InviteRow[])), [project.id, manage]);

  useEffect(() => {
    let live = true;
    api.keyStatus(project.id).then(
      (r) => live && setHasKey(r.hasKey),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [project.id]);

  // Who the signed-in person may change: the host can change anyone else; an admin can change members.
  const canChange = (m: ProjectMember) => m.id !== me.id && m.role !== "host" && (project.my_role === "host" || (project.my_role === "admin" && m.role === "member"));

  async function setRole(m: ProjectMember, role: AssignableRole) {
    try {
      await api.setRole(project.id, m.id, role);
      notifyChanged();
    } catch (e) {
      toast.push(messageOf(e), "error");
    }
  }

  async function remove(m: ProjectMember) {
    setBusy(true);
    try {
      await api.removeMember(project.id, m.id);
      notifyChanged();
      if (m.id === me.id) {
        onClose();
        navigate({ name: "home" });
      } else setConfirm(null);
    } catch (e) {
      toast.push(messageOf(e), "error");
    } finally {
      setBusy(false);
    }
  }

  if (confirm) {
    const self = confirm.id === me.id;
    return (
      <Dialog title={self ? `Leave ${project.name}?` : `Remove ${confirm.display_name}?`} onClose={() => setConfirm(null)}>
        <p className="lead">
          {self
            ? "You will lose access to every chat in this project. Someone has to invite you again to come back."
            : `${confirm.display_name} will lose access to every chat in ${project.name}. Their past messages stay in the chats.`}
        </p>
        <div className="dialog-actions">
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="danger" busy={busy} onClick={() => void remove(confirm)}>
            {self ? "Leave project" : "Remove"}
          </Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={`People in ${project.name}`} onClose={onClose} width={520}>
      <ul className="people-list">
        {members.map((m) => (
          <li key={m.id}>
            <Avatar id={m.id} name={m.display_name} size={32} online={online.has(m.id)} />
            <div className="grow">
              <div className="truncate">
                <b>{m.display_name}</b>
                {m.id === me.id && <span className="muted"> (you)</span>}
              </div>
              <div className="small muted truncate">{m.email}</div>
            </div>
            {hasKey[m.id] === false && <span className="chip" title="Can chat with people, but not use Claude">No AI key</span>}
            {canChange(m) ? (
              <Menu
                label={`Role for ${m.display_name}`}
                align="end"
                items={[
                  ...ASSIGNABLE_ROLES.map((r) => ({ label: ROLE_LABELS[r], checked: m.role === r, onSelect: () => void setRole(m, r) })),
                  "divider" as const,
                  { label: "Remove from project", danger: true, icon: <UserMinus size={ICON_SM} strokeWidth={STROKE} />, onSelect: () => setConfirm(m) },
                ]}
                trigger={({ toggle, open }) => (
                  <button type="button" className="role-btn" onClick={toggle} aria-expanded={open} aria-haspopup="menu">
                    {ROLE_LABELS[m.role]}
                    <ChevronDown size={ICON_SM} strokeWidth={STROKE} aria-hidden />
                  </button>
                )}
              />
            ) : (
              <span className="role-static">{ROLE_LABELS[m.role]}</span>
            )}
            {m.id === me.id && m.role !== "host" && (
              <Button size="sm" variant="ghost" onClick={() => setConfirm(m)}>
                <LogOut size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Leave
              </Button>
            )}
          </li>
        ))}
      </ul>
      {invites.data && <InviteList invites={invites.data} onChanged={invites.reload} />}
      <div className="dialog-actions">
        {manage && (
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              onInvite();
            }}
          >
            Invite someone
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ summarize

const SCOPES: { id: SummaryScope; title: string; text: string }[] = [
  { id: "unread", title: "What I missed", text: "Everything since you last read this chat." },
  { id: "day", title: "Last 24 hours", text: "All messages from the past day." },
  { id: "all", title: "Whole chat", text: "Everything in this chat." },
];

export function SummarizeDialog({ chatId, choice, readSeq, hasUnread, onClose }: { chatId: string; choice: ModelChoice | null; readSeq: number | null; hasUnread: boolean; onClose: () => void }) {
  const { openAddKey } = useApp();
  const [scope, setScope] = useState<SummaryScope>(hasUnread ? "unread" : "day");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!choice) {
    return (
      <Dialog title="Add an AI key first" onClose={onClose}>
        <p className="lead">A summary is written by Claude using your own key. Add one, and then try again.</p>
        <div className="dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              openAddKey();
            }}
          >
            Add a key
          </Button>
        </div>
      </Dialog>
    );
  }

  async function go() {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      await api.summarize(chatId, {
        id: crypto.randomUUID(),
        scope,
        fromSeq: scope === "unread" ? (readSeq ?? 0) : undefined,
        provider: choice.provider,
        model: choice.model,
        reasoning: choice.reasoning,
      });
      onClose();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Summarize this chat"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => void go()}>
            <Sparkles size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Summarize
          </Button>
        </>
      }
    >
      <div className="option-list" role="radiogroup" aria-label="What to summarize">
        {SCOPES.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={scope === s.id} className={`option ${scope === s.id ? "on" : ""}`} onClick={() => setScope(s.id)}>
            <span className="radio-dot" aria-hidden>{scope === s.id && <Check size={11} strokeWidth={3} />}</span>
            <span>
              <b>{s.title}</b>
              <span className="small muted block">{s.text}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="small muted">
        The summary is posted in the chat for everyone. It runs on your {PROVIDER_LABELS[choice.provider]} key with {modelButtonLabel(choice.model) || modelLabel(choice.model)}, so your key pays for it.
      </p>
      <ErrorLine>{error}</ErrorLine>
    </Dialog>
  );
}

// ------------------------------------------------------------------ deleting

export function DeleteChatDialog({ chatId, title, onClose, onDeleted }: { chatId: string; title: string; onClose: () => void; onDeleted: () => void }) {
  return (
    <ConfirmDialog
      title="Delete this chat?"
      confirmLabel="Delete chat"
      danger
      onClose={onClose}
      onConfirm={async () => {
        await api.deleteChat(chatId);
        notifyChanged();
        onDeleted();
      }}
    >
      <b className="strong">{title}</b> and all its messages are deleted for everyone in it. This can't be undone.
    </ConfirmDialog>
  );
}

export function DeleteProjectDialog({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  return (
    <ConfirmDialog
      title={`Delete ${project.name}?`}
      confirmLabel="Delete project"
      danger
      onClose={onClose}
      onConfirm={async () => {
        await api.deleteProject(project.id);
        notifyChanged();
        navigate({ name: "home" });
      }}
    >
      Every chat in the project is deleted for all {project.member_count} {project.member_count === 1 ? "person" : "people"}. This can't be undone.
    </ConfirmDialog>
  );
}
