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

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,app://desktop")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export const env = {
  supabaseUrl: required("SUPABASE_URL", "VITE_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, ""),
  supabaseSecretKey: required("SUPABASE_SECRET_KEY"),
  keyEncryptionSecret: required("KEY_ENCRYPTION_SECRET"),
  port: Number(process.env.PORT ?? 8787),
  allowedOrigins,
  /** The web app's address, used in invite links (https://app.example.com or http://localhost:5173). */
  appUrl: (process.env.APP_URL?.trim() || allowedOrigins.find((o) => o.startsWith("http")) || "http://localhost:5173").replace(/\/$/, ""),
  /** Optional: this server's own public address (https://chat.example.com), used as the OAuth redirect for remote MCP servers. Without it, OAuth sign-in is off. */
  serverUrl: process.env.SERVER_URL?.trim().replace(/\/$/, "") || null,
  /** Optional: sends invite emails through Resend. Without it the link is shown to copy. */
  resendApiKey: process.env.RESEND_API_KEY?.trim() || null,
  mailFrom: process.env.MAIL_FROM?.trim() || null,
  /** Set to 1 only when the server runs behind a proxy that sets X-Forwarded-For (Fly.io does). */
  trustProxy: process.env.TRUST_PROXY === "1",
  /** Optional: Cloudflare R2, where a project's shared files are stored. All four are set together, or file storage is off. */
  r2: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID?.trim() || null,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim() || null,
    endpoint: process.env.R2_ENDPOINT?.trim().replace(/\/$/, "") || null,
    bucket: process.env.R2_BUCKET?.trim() || null,
  },
};

if (!env.supabaseUrl.startsWith("https://") && !env.supabaseUrl.startsWith("http://localhost")) {
  throw new Error("SUPABASE_URL must use https://");
}
if (!/^https:\/\//.test(env.appUrl) && !/^http:\/\/localhost(:\d+)?$/.test(env.appUrl)) {
  throw new Error("APP_URL must use https:// (http://localhost is allowed for development)");
}
if (env.serverUrl && !/^https:\/\//.test(env.serverUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.serverUrl)) {
  throw new Error("SERVER_URL must use https:// (http://localhost is allowed for development)");
}
if (env.resendApiKey && !env.mailFrom) throw new Error("MAIL_FROM is required when RESEND_API_KEY is set");
{
  const set = Object.entries({ R2_ACCESS_KEY_ID: env.r2.accessKeyId, R2_SECRET_ACCESS_KEY: env.r2.secretAccessKey, R2_ENDPOINT: env.r2.endpoint, R2_BUCKET: env.r2.bucket });
  const missing = set.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0 && missing.length < set.length) throw new Error(`File storage needs all of R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT and R2_BUCKET. Missing: ${missing.join(", ")}`);
  if (env.r2.endpoint && !/^https:\/\//.test(env.r2.endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.r2.endpoint)) {
    throw new Error("R2_ENDPOINT must use https:// (http://localhost is allowed for development)");
  }
}
