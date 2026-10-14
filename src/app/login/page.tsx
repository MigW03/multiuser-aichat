"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { safeNext } from "@/lib/safe-next";

export default function LoginPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 p-6">
      {/* The form reads ?next and ?mode; the boundary lets the rest of the page prerender. */}
      <Suspense fallback={<div className="h-72 animate-pulse rounded-md bg-neutral-100 dark:bg-neutral-900" />}>
        <LoginForm />
      </Suspense>
    </main>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const fromInvite = next.startsWith("/invite/");
  const [mode, setMode] = useState<"signin" | "signup">(params.get("mode") === "signup" ? "signup" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    const supabase = createClient();

    if (mode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setBusy(false);
      if (error) return setError(error.message);
      router.replace(next);
      router.refresh();
      return;
    }

    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: name } } });
    setBusy(false);
    if (error) return setError(error.message);
    if (!data.session) {
      // Email confirmation is on in Supabase: there's no session until the address is confirmed.
      setMode("signin");
      return setInfo("Check your inbox to confirm your email, then sign in here to continue.");
    }
    // New accounts start with the API key step; it continues to `next` when done or skipped.
    router.replace(`/welcome?next=${encodeURIComponent(next)}`);
    router.refresh();
  }

  const input = "w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700";

  return (
    <>
      <h1 className="text-2xl font-semibold">{mode === "signin" ? "Sign in" : "Create account"}</h1>
      {fromInvite && (
        <p className="text-sm text-neutral-500">
          {mode === "signup"
            ? "You've been invited to a chat. Create an account to join it."
            : "Sign in to join the chat you were invited to."}
        </p>
      )}
      <form onSubmit={submit} className="flex flex-col gap-3">
        {mode === "signup" && (
          <input className={input} placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} required />
        )}
        <input className={input} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className={input} type="password" placeholder="Password" minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="text-sm text-red-600">{error}</p>}
        {info && <p className="text-sm text-neutral-500">{info}</p>}
        <button disabled={busy} className="rounded-md bg-foreground px-3 py-2 text-background disabled:opacity-50">
          {mode === "signin" ? "Sign in" : "Sign up"}
        </button>
      </form>
      <button className="text-sm underline" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
        {mode === "signin" ? "No account? Sign up" : "Have an account? Sign in"}
      </button>
    </>
  );
}
