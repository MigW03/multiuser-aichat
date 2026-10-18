import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  envDir: "..", // the repo root's .env.local
  // Only these prefixes reach the browser bundle. Server secrets (SUPABASE_SECRET_KEY, KEY_ENCRYPTION_SECRET) never match.
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  base: "./", // relative asset paths, so the desktop app can load the same build from app://
  server: { port: 5173, strictPort: true },
});
