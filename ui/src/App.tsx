import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { configError } from "./config.ts";
import { supabase } from "./supabase.ts";
import { Login } from "./components/Login.tsx";
import { Shell } from "./components/Shell.tsx";

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    if (configError) return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      // Private realtime channels authorize with the current access token.
      if (next) void supabase.realtime.setAuth(next.access_token);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (configError) return <div className="center danger">{configError}</div>;
  if (session === undefined) return <div className="center muted">Loading…</div>;
  if (!session) return <Login />;
  return <Shell key={session.user.id} userId={session.user.id} />;
}
