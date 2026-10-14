import { createClient } from "@supabase/supabase-js";
import { config } from "./config.ts";

export const supabase = createClient(config.supabaseUrl || "http://invalid.localhost", config.supabaseAnonKey || "missing", {
  auth: { persistSession: true, autoRefreshToken: true },
});
