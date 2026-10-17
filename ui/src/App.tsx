import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { configError } from "./config.ts";
import { navigate, useRoute } from "./lib/router.ts";
import { supabase } from "./supabase.ts";
import { AuthScreen } from "./components/Auth.tsx";
import { JoinSignedOut } from "./components/Join.tsx";
import { Shell } from "./components/Shell.tsx";
import { Spinner, ToastProvider } from "./components/kit.tsx";

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const route = useRoute();

  useEffect(() => {
    if (configError) return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      // Private realtime channels authorize with the current access token.
      if (next) void supabase.realtime.setAuth(next.access_token);
      // The link in a password reset email signs the person in for the purpose of choosing a new password.
      if (event === "PASSWORD_RECOVERY") navigate({ name: "reset" }, { replace: true });
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (configError) return <div className="center-screen error-line">{configError}</div>;

  let screen;
  if (session === undefined) {
    screen = (
      <div className="center-screen">
        <Spinner />
      </div>
    );
  } else if (!session) {
    screen = route.name === "join" ? <JoinSignedOut token={route.token} /> : <AuthScreen />;
  } else {
    screen = <Shell key={session.user.id} userId={session.user.id} />;
  }
  return <ToastProvider>{screen}</ToastProvider>;
}
