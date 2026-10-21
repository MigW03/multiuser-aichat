import { LIMITS } from "@mc/shared";
import { Eye, EyeOff, Mail, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { navigate } from "../lib/router.ts";
import { PREF, writePref } from "../lib/prefs.ts";
import { authErrorMessage, clearAuthError, peekAuthError } from "../lib/authError.ts";
import { authRedirectUrl, config, googleSignInAvailable, isDesktopApp } from "../config.ts";
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

const GOOGLE_WAIT_MS = 3 * 60 * 1000;

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.5 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
      <path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

/**
 * Sign in with Google. In a browser the page goes to Google and comes back. In the desktop app the Google page opens in the
 * system browser and the multiuserchat://auth link brings the person back (the app reloads signed in), so here it waits.
 * `email` (an invite) is passed as a hint so the account chooser starts on the invited address.
 */
function GoogleButton({ label, email, joinToken, onError }: { label: string; email?: string; joinToken?: string; onError: (message: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setWaiting(false), GOOGLE_WAIT_MS);
    return () => clearTimeout(t);
  }, [waiting]);

  // Coming back to this page with the browser's back button must not leave the button stuck.
  useEffect(() => {
    const show = (e: PageTransitionEvent) => e.persisted && setBusy(false);
    window.addEventListener("pageshow", show);
    return () => window.removeEventListener("pageshow", show);
  }, []);

  async function start() {
    onError(null);
    setBusy(true);
    if (joinToken) writePref(PREF.pendingJoin, joinToken);
    const inApp = isDesktopApp();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: authRedirectUrl(),
        skipBrowserRedirect: inApp,
        queryParams: { prompt: "select_account", ...(email ? { login_hint: email } : {}) },
      },
    });
    // The address comes from Supabase; still only ever hand the system browser our own Supabase address.
    if (error || (inApp && !data.url?.startsWith(`${config.supabaseUrl.replace(/\/$/, "")}/auth/v1/authorize`))) {
      setBusy(false);
      return onError("Google sign-in is not available right now. Use email instead.");
    }
    if (inApp) {
      window.open(data.url, "_blank", "noopener");
      setBusy(false);
      setWaiting(true);
    }
  }

  if (waiting) {
    return (
      <div className="google-wait">
        <span className="spinner" aria-hidden />
        <span>Waiting for Google in your browser…</span>
        <button type="button" className="link-btn small" onClick={() => setWaiting(false)}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <Button size="md" block busy={busy} onClick={() => void start()}>
      {!busy && <GoogleMark />}
      {label}
    </Button>
  );
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
  // Came back from a failed Google sign-in or an expired email link: say so.
  const [error, setError] = useState<string | null>(() => {
    const code = peekAuthError();
    return code ? authErrorMessage(code) : null;
  });
  const [checkEmail, setCheckEmail] = useState<string | null>(null);
  const signup = mode === "signup";

  useEffect(() => clearAuthError(), []);

  const shownMode = useRef(mode);
  useEffect(() => {
    if (shownMode.current === mode) return;
    shownMode.current = mode;
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
          options: { data: { display_name: name.trim().slice(0, LIMITS.displayNameChars) }, emailRedirectTo: authRedirectUrl() },
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
      {googleSignInAvailable() && (
        <>
          <GoogleButton
            label={joinLabel ? `${joinLabel} with Google` : signup ? "Sign up with Google" : "Continue with Google"}
            email={fixedEmail}
            joinToken={joinToken}
            onError={setError}
          />
          <div className="auth-or" role="separator">
            <span>or</span>
          </div>
        </>
      )}
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
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: authRedirectUrl() });
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
    const { error: e } = await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: authRedirectUrl() } });
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
