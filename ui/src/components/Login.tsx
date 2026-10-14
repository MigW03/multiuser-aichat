import { useState, type FormEvent } from "react";
import { supabase } from "../supabase.ts";

export function Login() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    const result =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email: email.trim(), password })
        : await supabase.auth.signUp({ email: email.trim(), password, options: { data: { display_name: name.trim() } } });
    setBusy(false);
    if (result.error) return setError(result.error.message);
    if (mode === "signup" && !result.data.session) setInfo("Check your email to confirm your account, then sign in.");
  }

  return (
    <div className="center">
      <form className="card col auth" onSubmit={submit}>
        <div className="title">{mode === "signin" ? "Sign in" : "Create account"}</div>
        {mode === "signup" && (
          <input className="input" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
        )}
        <input className="input" type="email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input
          className="input"
          type="password"
          placeholder="Password"
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          minLength={mode === "signup" ? 8 : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <div className="danger small">{error}</div>}
        {info && <div className="success small">{info}</div>}
        <button className="btn primary" disabled={busy}>
          {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
        <button type="button" className="btn link small" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
          {mode === "signin" ? "No account? Create one" : "Have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
