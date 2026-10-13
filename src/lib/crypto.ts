import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM with a server-side secret. Server-only: never import from client code.
function secret(): Buffer {
  const raw = process.env.KEY_ENCRYPTION_SECRET;
  const key = raw ? Buffer.from(raw, "base64") : null;
  if (!key || key.length !== 32) {
    throw new Error("KEY_ENCRYPTION_SECRET must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  }
  return key;
}

/** Returns `v1.<iv>.<tag>.<ciphertext>` (base64 parts). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export function decrypt(payload: string): string {
  const [version, iv, tag, data] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unrecognised key format");
  const decipher = createDecipheriv("aes-256-gcm", secret(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
