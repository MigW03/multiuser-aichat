import { LIMITS } from "@mc/shared";
import { Eye, EyeOff, Mail, Sparkles } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { navigate } from "../lib/router.ts";
import { PREF, writePref } from "../lib/prefs.ts";
import { supabase } from "../supabase.ts";
import { Button, ErrorLine, Field, IconButton, ICON, STROKE, TextInput } from "./kit.tsx";

export function AuthLayout({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="auth-page">
      <main className="auth-card">
        <div className="auth-col" style={wide ? { width: 440 } : undefined}>
          {children}
        </div>
      </main>
    </div>
  );
}

export function BrandMark({ small }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? "small" : ""}`} aria-hidden>
      <Sparkles size={small ? 14 : 20} strokeWidth={2} />
    </span>
  );
}

function PasswordInput({ id, value, onChange, autoComplete, placeholder, invalid }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; placeholder?: string; invalid?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="input-wrap">
      <TextInput id={id} type={shown ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} placeholder={placeholder} invalid={invalid} required />
      <IconButton label={shown ? "Hide password" : "Show password"} onClick={() => setShown((s) => !s)}>
        {shown ? <EyeOff size={ICON} strokeWidth={STROKE} /> : <Eye size={ICON} strokeWidth={STROKE} />}
      </IconButton>
    </div>
  );
}

function friendly(message: string): string {
  if (/invalid login credentials/i.test(message)) return "Wrong email or password.";
  if (/email not confirmed/i.test(message)) return "Confirm your email first. We sent you a link when you signed up.";
  if (/rate limit|too many/i.test(message)) return "Too many tries. Wait a minute and try again.";
  if (/password.*(short|least|weak)/i.test(message)) return `Use ${LIMITS.passwordMin} or more characters for the password.`;
  return message;
}

export type AuthMode = "login" | "signup";

/**
 * Log in or create an account. With `email` set (an invite), the address is fixed to the one the invite was sent to.
 * `joinToken` is remembered so the person lands on the invite again after confirming their email.
 */
export function AuthForm({
  mode,
  onMode,
  email: fixedEmail,
  joinToken,
  joinLabel,
}: {
  mode: AuthMode;
  onMode: (m: AuthMode) => void;
  email?: string;
  joinToken?: string;
  joinLabel?: string;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState(fixedEmail ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState<string | null>(null);
  const signup = mode === "signup";

  useEffect(() => {
    setError(null);
    setPassword("");
    setConfirm("");
  }, [mode]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const address = (fixedEmail ?? email).trim();
    if (signup) {
      if (!name.trim()) return setError("Enter your name.");
      if (password.length < LIMITS.passwordMin) return setError(`Use ${LIMITS.passwordMin} or more characters for the password.`);
      if (password !== confirm) return setError("The two passwords don't match.");
    }
    setBusy(true);
    if (joinToken) writePref(PREF.pendingJoin, joinToken);
    const result = signup
      ? await supabase.auth.signUp({
          email: address,
          password,
          options: { data: { display_name: name.trim().slice(0, LIMITS.displayNameChars) }, emailRedirectTo: `${location.origin}${location.pathname}` },
        })
      : await supabase.auth.signInWithPassword({ email: address, password });
    setBusy(false);
    if (result.error) return setError(friendly(result.error.message));
    // With email confirmation on, sign-up gives no session until the link in the email is opened.
    if (signup && !result.data.session) setCheckEmail(address);
  }

  if (checkEmail) return <CheckEmail email={checkEmail} onBack={() => setCheckEmail(null)} />;

  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      <Field label={signup ? "Your name" : "Email"} htmlFor="auth-first" hint={undefined}>
        {signup ? (
          <TextInput id="auth-first" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={LIMITS.displayNameChars} placeholder="Name others will see" required />
        ) : (
          <TextInput id="auth-first" type="email" value={fixedEmail ?? email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" disabled={!!fixedEmail} required />
        )}
      </Field>
      {signup && (
        <Field label="Email" htmlFor="auth-email" hint={fixedEmail ? "Invites only work with the email they were sent to." : undefined}>
          <TextInput id="auth-email" type="email" value={fixedEmail ?? email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" disabled={!!fixedEmail} required />
        </Field>
      )}
      <Field
        label="Password"
        htmlFor="auth-password"
        hint={signup ? `Use ${LIMITS.passwordMin} or more characters.` : undefined}
      >
        <PasswordInput id="auth-password" value={password} onChange={setPassword} autoComplete={signup ? "new-password" : "current-password"} placeholder={signup ? `At least ${LIMITS.passwordMin} characters` : undefined} />
      </Field>
      {!signup && (
        <div className="auth-forgot">
          <ForgotLink email={fixedEmail ?? email} />
        </div>
      )}
      {signup && (
        <Field label="Confirm password" htmlFor="auth-confirm">
          <PasswordInput id="auth-confirm" value={confirm} onChange={setConfirm} autoComplete="new-password" placeholder="Type it again" invalid={!!confirm && confirm !== password} />
        </Field>
      )}
      <ErrorLine>{error}</ErrorLine>
      <Button type="submit" variant="primary" size="md" block busy={busy}>
        {joinLabel ?? (signup ? "Create account" : "Log in")}
      </Button>
      <div className="auth-switch">
        {signup ? "Already have an account? " : "New here? "}
        <button type="button" className="link-btn" onClick={() => onMode(signup ? "login" : "signup")}>
          {signup ? (joinToken ? "Log in to join" : "Log in") : "Create an account"}
        </button>
      </div>
    </form>
  );
}

function ForgotLink({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sent" | "error">("idle");
  async function send() {
    if (!email.trim()) return setState("error");
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${location.origin}${location.pathname}` });
    setState(error ? "error" : "sent");
  }
  if (state === "sent") return <span className="small muted">If that address has an account, a reset link is on its way.</span>;
  return (
    <>
      <button type="button" className="link-btn small" onClick={() => void send()}>
        Forgot password?
      </button>
      {state === "error" && <span className="small muted"> Enter your email above first.</span>}
    </>
  );
}

export function CheckEmail({ email, onBack }: { email: string; onBack: () => void }) {
  const [wait, setWait] = useState(30);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function resend() {
    setError(null);
    const { error: e } = await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: `${location.origin}${location.pathname}` } });
    if (e) setError(friendly(e.message));
    else setWait(30);
  }

  return (
    <div className="auth-form center-text">
      <span className="mail-badge" aria-hidden>
        <Mail size={26} strokeWidth={STROKE} />
      </span>
      <h1 className="auth-title">Check your email</h1>
      <p className="lead">
        We sent a confirmation link to
        <br />
        <b className="strong">{email}</b>.
        <br />
        Open it to finish setting up your account.
      </p>
      <Button block disabled={wait > 0} onClick={() => void resend()}>
        Resend email
      </Button>
      <ErrorLine>{error}</ErrorLine>
      {wait > 0 && <p className="small muted">You can resend in {wait} seconds.</p>}
      <button type="button" className="link-btn" onClick={onBack}>
        Use a different email
      </button>
    </div>
  );
}

export function AuthScreen() {
  const [mode, setMode] = useState<AuthMode>("login");
  return (
    <AuthLayout>
      <div className="auth-head">
        <BrandMark />
        <h1 className="auth-title">{mode === "login" ? "Log in" : "Create your account"}</h1>
        <p className="lead">{mode === "login" ? "Pick up where your team left off." : "You add your own AI key after you sign in."}</p>
      </div>
      <AuthForm mode={mode} onMode={setMode} />
    </AuthLayout>
  );
}

/** Shown after the link in a password reset email is opened. */
export function ResetPassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < LIMITS.passwordMin) return setError(`Use ${LIMITS.passwordMin} or more characters for the password.`);
    if (password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (err) return setError(friendly(err.message));
    navigate({ name: "home" }, { replace: true });
  }

  return (
    <AuthLayout>
      <div className="auth-head">
        <BrandMark />
        <h1 className="auth-title">Choose a new password</h1>
      </div>
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field label="New password" htmlFor="rp1" hint={`Use ${LIMITS.passwordMin} or more characters.`}>
          <PasswordInput id="rp1" value={password} onChange={setPassword} autoComplete="new-password" />
        </Field>
        <Field label="Confirm password" htmlFor="rp2">
          <PasswordInput id="rp2" value={confirm} onChange={setConfirm} autoComplete="new-password" invalid={!!confirm && confirm !== password} />
        </Field>
        <ErrorLine>{error}</ErrorLine>
        <Button type="submit" variant="primary" block busy={busy}>
          Save password
        </Button>
      </form>
    </AuthLayout>
  );
}
