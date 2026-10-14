/**
 * Where to send the user after signing in: only same-site paths, so a crafted
 * `?next=https://evil.example` (or `//evil.example`) can't redirect off the app.
 */
export function safeNext(value: string | null | undefined, fallback = "/"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}
