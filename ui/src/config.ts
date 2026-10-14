// Public settings baked in at build time by the host app (web or desktop). Never put secrets here.
const env = import.meta.env;

export const config = {
  supabaseUrl: (env.VITE_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? "") as string,
  supabaseAnonKey: (env.VITE_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "") as string,
  serverUrl: ((env.VITE_SERVER_URL as string | undefined) ?? "http://localhost:8787").replace(/\/$/, ""),
};

export const configError =
  !config.supabaseUrl || !config.supabaseAnonKey ? "Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local, then restart." : null;
