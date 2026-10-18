import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Local development reads the repo's .env.local / .env. Real deployments (Fly.io) set environment variables.
for (const file of [".env.local", ".env"]) {
  for (const dir of [process.cwd(), resolve(import.meta.dirname, "../..")]) {
    const path = resolve(dir, file);
    if (existsSync(path)) process.loadEnvFile(path);
  }
}

function required(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Missing environment variable ${names[0]}`);
}

export const env = {
  supabaseUrl: required("SUPABASE_URL", "VITE_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, ""),
  supabaseSecretKey: required("SUPABASE_SECRET_KEY"),
  keyEncryptionSecret: required("KEY_ENCRYPTION_SECRET"),
  port: Number(process.env.PORT ?? 8787),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,app://desktop")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
};

if (!env.supabaseUrl.startsWith("https://") && !env.supabaseUrl.startsWith("http://localhost")) {
  throw new Error("SUPABASE_URL must use https://");
}
