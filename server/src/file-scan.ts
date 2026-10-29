import { redactSecrets } from "@mc/shared";

// A file that holds a key or token is not stored: members would download it as it is, without the masking that reads of a
// shared folder get. Only text is checked (a NUL byte early on means a picture, archive or other binary). Secrets are plain
// ASCII, so the bytes are read as Latin-1 in pieces, which keeps memory small and never splits a character.

const CHUNK = 1024 * 1024;
/** Longer than any key block, so one that straddles two pieces is still seen whole. */
const OVERLAP = 8 * 1024;
const SNIFF = 8000;

export function looksLikeText(bytes: Uint8Array): boolean {
  return !bytes.subarray(0, SNIFF).includes(0);
}

export function containsSecret(bytes: Uint8Array): boolean {
  if (!looksLikeText(bytes)) return false;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < buf.length; at += CHUNK) {
    const piece = buf.toString("latin1", at, Math.min(buf.length, at + CHUNK + OVERLAP));
    if (redactSecrets(piece) !== piece) return true;
  }
  return false;
}
