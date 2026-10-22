import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // OpenUI's development widget loads a script from a CDN; the app never runs remote code (see ui/src/genui/no-devtools.ts).
  resolve: { alias: { "@openuidev/devtools": fileURLToPath(new URL("../ui/src/genui/devtools-stub.ts", import.meta.url)) } },
  envDir: "..", // the repo root's .env.local
  // Only these prefixes reach the browser bundle. Server secrets (SUPABASE_SECRET_KEY, KEY_ENCRYPTION_SECRET) never match.
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  base: "./", // relative asset paths, so the desktop app can load the same build from app://
  server: { port: 5173, strictPort: true },
});
