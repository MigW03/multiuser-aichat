import { createClient } from "@supabase/supabase-js";
import { env } from "./env.ts";

/** Service-role client: bypasses RLS. Every route checks the caller's membership itself before using it. */
export const admin = createClient(env.supabaseUrl, env.supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export type Admin = typeof admin;
