import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env.ts";

// AES-256-GCM for API keys at rest. Format: base64(iv[12] | tag[16] | ciphertext).
const key = Buffer.from(env.keyEncryptionSecret, "base64");
if (key.length !== 32) throw new Error("KEY_ENCRYPTION_SECRET must be 32 bytes, base64 (openssl rand -base64 32)");

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function decrypt(ciphertext: string): string {
  const raw = Buffer.from(ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
