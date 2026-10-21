import { createClient } from "@supabase/supabase-js";
import { config } from "./config.ts";
// Imported before the client exists so it can read a sign-in error from the address before the client cleans it up.
import "./lib/authError.ts";

export const supabase = createClient(config.supabaseUrl || "http://invalid.localhost", config.supabaseAnonKey || "missing", {
  auth: { persistSession: true, autoRefreshToken: true },
});
