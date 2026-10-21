// When a sign-in (Google, or the link in an email) fails, Supabase sends the person back to the app with the reason in the
// address, in the query and/or the fragment. Read it once, before the Supabase client cleans the address up.

/** The error code from a returned address, or null when there is none. Only the code is kept, never the provider's text. */
export function parseAuthError(search: string, hash: string): string | null {
  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  const query = new URLSearchParams(search);
  const error = fragment.get("error") ?? query.get("error");
  if (!error) return null;
  return (fragment.get("error_code") ?? query.get("error_code") ?? error).toLowerCase().slice(0, 60);
}

/** The sentence to show for a returned error. Expired email links say so; anything else came from Google. */
export function authErrorMessage(code: string): string {
  if (/otp|expired/.test(code)) return "That link has expired. Ask for a new one.";
  if (code === "access_denied") return "Google sign-in was cancelled.";
  return "Google sign-in failed. Try again, or use email.";
}

let captured: string | null = null;
if (typeof location !== "undefined") captured = parseAuthError(location.search, location.hash);

/** The error the page was opened with, until it is cleared. */
export const peekAuthError = (): string | null => captured;

/** Forget the error once it has been shown, so a later visit to the log-in page doesn't show it again. */
export function clearAuthError() {
  captured = null;
}
