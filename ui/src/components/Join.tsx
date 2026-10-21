import type { InvitePreview } from "@mc/shared";
import { ROLE_LABELS } from "@mc/shared";
import { LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiRequestError } from "../api.ts";
import { useApp } from "../data.tsx";
import { clearPref, PREF, readPref, writePref } from "../lib/prefs.ts";
import { navigate } from "../lib/router.ts";
import { supabase } from "../supabase.ts";
import { AuthForm, AuthLayout, BrandMark, type AuthMode } from "./Auth.tsx";
import { joinChatNotice, joinProjectNotice, NoticeBody } from "./Notice.tsx";
import { Avatar, Button, Dialog, ErrorLine, Spinner } from "./kit.tsx";

export function ProjectTile({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <span className="project-tile" style={{ width: size, height: size, fontSize: Math.round(size * 0.42), borderRadius: Math.round(size * 0.25) }} aria-hidden>
      {name.trim()[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

function usePreview(token: string) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setPreview(null);
    api.previewInvite(token).then(
      (p) => live && setPreview(p),
      (e: unknown) => live && setError(e instanceof Error ? e.message : "Could not open this invite."),
    );
    return () => {
      live = false;
    };
  }, [token]);
  return { preview, error };
}

function Problem({ title, text, label, children }: { title: string; text: string; label: string; children: React.ReactNode }) {
  return (
    <AuthLayout>
      <div className="auth-form center-text">
        <BrandMark />
        <span className="chip">{label}</span>
        <h1 className="auth-title">{title}</h1>
        <p className="lead">{text}</p>
        {children}
      </div>
    </AuthLayout>
  );
}

function InviteCard({ preview }: { preview: InvitePreview }) {
  const chat = preview.scope === "chat";
  return (
    <div className="invite-card">
      <ProjectTile name={preview.name ?? "?"} />
      <h1 className="auth-title">
        {preview.inviter ?? "Someone"} invited you to {preview.name}
      </h1>
      <p className="lead">{chat ? "You will join this chat only." : `You will join as ${preview.role === "admin" ? "an admin" : "a member"}.`}</p>
      {preview.members.length > 0 && (
        <div className="already-in">
          <div className="section-label">
            <span>Already in</span>
          </div>
          <ul>
            {preview.members.map((m, i) => (
              <li key={i}>
                <Avatar id={`${m.name}-${i}`} name={m.name} src={m.avatar} size={24} />
                <span>{m.name}</span>
                {m.role !== "member" && <span className="muted small">· {ROLE_LABELS[m.role].toLowerCase()}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The page behind an invite link, for people who are signed out. */
export function JoinSignedOut({ token }: { token: string }) {
  const { preview, error } = usePreview(token);
  const [mode, setMode] = useState<AuthMode>("signup");

  if (error) return <Problem label="Invite" title="Could not open this invite" text={error} ><Button onClick={() => navigate({ name: "home" })}>Back to log in</Button></Problem>;
  if (!preview) return <div className="center-screen"><Spinner /></div>;
  if (preview.status === "invalid" || preview.status === "used") {
    return (
      <Problem label="Invalid" title="This invite isn't valid" text="The link may be mistyped, or it was already used.">
        <Button onClick={() => navigate({ name: "home" })}>Back to log in</Button>
      </Problem>
    );
  }
  if (preview.status === "expired") {
    return (
      <Problem label="Expired" title="This invite has expired" text={`Invites last 7 days. Ask ${preview.inviter ?? "the person who invited you"} to send you a new one.`}>
        <Button onClick={() => navigate({ name: "home" })}>Back to log in</Button>
      </Problem>
    );
  }
  if (preview.status === "full") {
    return (
      <Problem label="Full" title={`${preview.name} is full`} text={`A ${preview.scope === "chat" ? "chat" : "project"} holds up to 10 people. Ask ${preview.inviter ?? "the person who invited you"} to make room, then try the link again.`}>
        <Button onClick={() => navigate({ name: "home" })}>Back to log in</Button>
      </Problem>
    );
  }
  return (
    <AuthLayout wide>
      <InviteCard preview={preview} />
      <AuthForm mode={mode} onMode={setMode} email={preview.email ?? undefined} joinToken={token} joinLabel={`Join ${preview.name}`} />
    </AuthLayout>
  );
}

/** The invite page for someone who is signed in. */
export function JoinSignedIn({ token, userId }: { token: string; userId: string }) {
  const { me } = useApp();
  const { preview, error } = usePreview(token);
  const [notice, setNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Arrived from the confirmation email: the pending token has done its job.
  useEffect(() => clearPref(PREF.pendingJoin), []);

  async function accept() {
    setBusy(true);
    setFailure(null);
    try {
      const joined = await api.acceptInvite(token);
      if (joined.projectId) navigate({ name: "project", projectId: joined.projectId, chatId: null }, { replace: true });
      else if (joined.chatId) navigate({ name: "homeChat", chatId: joined.chatId }, { replace: true });
      else navigate({ name: "home" }, { replace: true });
    } catch (e) {
      setFailure(e instanceof ApiRequestError ? e.message : "Could not join.");
      setNotice(false);
    } finally {
      setBusy(false);
    }
  }

  function start() {
    if (readPref(PREF.hideJoinNotice(userId), false)) void accept();
    else setNotice(true);
  }

  const back = <Button onClick={() => navigate({ name: "home" })}>Back to your projects</Button>;
  if (error) return <Problem label="Invite" title="Could not open this invite" text={error}>{back}</Problem>;
  if (!preview) return <div className="center-screen"><Spinner /></div>;
  if (preview.status === "invalid" || preview.status === "used") {
    return <Problem label="Invalid" title="This invite isn't valid" text="The link may be mistyped, or it was already used.">{back}</Problem>;
  }
  if (preview.status === "expired") {
    return <Problem label="Expired" title="This invite has expired" text={`Invites last 7 days. Ask ${preview.inviter ?? "the person who invited you"} to send you a new one.`}>{back}</Problem>;
  }
  if (preview.status === "full") {
    return (
      <Problem label="Full" title={`${preview.name} is full`} text={`A ${preview.scope === "chat" ? "chat" : "project"} holds up to 10 people. Ask ${preview.inviter ?? "the person who invited you"} to make room, then try the link again.`}>
        {back}
      </Problem>
    );
  }
  if (preview.emailMasked) {
    return (
      <Problem label="Wrong account" title="This invite is for another email" text={`It was sent to ${preview.email}. You're signed in as ${me.email}.`}>
        <Button onClick={() => void supabase.auth.signOut()}>
          <LogOut size={14} strokeWidth={1.75} aria-hidden /> Log out and switch
        </Button>
        {back}
      </Problem>
    );
  }

  const notices = preview.scope === "chat" ? joinChatNotice(preview.name ?? "this chat", preview.members.length) : joinProjectNotice(preview.name ?? "this project", preview.members.length);
  return (
    <AuthLayout wide>
      <InviteCard preview={preview} />
      <ErrorLine>{failure}</ErrorLine>
      <Button variant="primary" block busy={busy} onClick={start}>
        Join {preview.name}
      </Button>
      <button type="button" className="link-btn center-text" onClick={() => navigate({ name: "home" })}>
        Not now
      </button>
      {notice && (
        <Dialog onClose={() => setNotice(false)} width={460} label="Before you join">
          <NoticeBody
            {...notices}
            confirmLabel={preview.scope === "chat" ? "Join chat" : "Join project"}
            cancelLabel="Cancel"
            busy={busy}
            error={failure}
            onCancel={() => setNotice(false)}
            onConfirm={(never) => {
              if (never) writePref(PREF.hideJoinNotice(userId), true);
              void accept();
            }}
          />
        </Dialog>
      )}
    </AuthLayout>
  );
}
