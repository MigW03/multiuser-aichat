import { useEffect, useReducer } from "react";
import { api } from "../api.ts";
import { supabase } from "../supabase.ts";

// Pictures live in private storage. The server hands out addresses that work for an hour to people in the chat; they are
// asked for in batches and kept here so scrolling does not ask again. A picture just sent from this tab shows from its
// local copy.

const REFRESH_AFTER_MS = 50 * 60_000;
const BATCH_MS = 40;

const known = new Map<string, { url: string; until: number }>();
/** Ids the server said are not available to this person. */
const missing = new Set<string>();
const queued = new Map<string, Set<string>>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

const notify = () => listeners.forEach((l) => l());

/** Shows a picture from this address (a local copy of the file) until the server's address is needed. */
export function seedPictureUrl(id: string, url: string) {
  known.set(id, { url, until: Number.POSITIVE_INFINITY });
  missing.delete(id);
  notify();
}

async function flush() {
  timer = undefined;
  const batches = [...queued];
  queued.clear();
  for (const [chatId, ids] of batches) {
    const list = [...ids];
    for (let i = 0; i < list.length; i += 100) {
      const part = list.slice(i, i + 100);
      try {
        const { urls } = await api.imageUrls(chatId, part);
        for (const id of part) {
          if (urls[id]) known.set(id, { url: urls[id], until: Date.now() + REFRESH_AFTER_MS });
          else missing.add(id);
        }
      } catch {
        /* offline or the server is restarting: the next render asks again */
      } finally {
        for (const id of part) asked.delete(id);
      }
    }
  }
  notify();
}

function request(chatId: string, id: string) {
  if (asked.has(id)) return;
  asked.add(id);
  const ids = queued.get(chatId) ?? new Set<string>();
  ids.add(id);
  queued.set(chatId, ids);
  timer ??= setTimeout(() => void flush(), BATCH_MS);
}

// Another person signing in on the same tab must not see addresses fetched for the last person.
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_IN" || event === "SIGNED_OUT") {
    known.clear();
    missing.clear();
  }
});

/** The address to show a picture from, once it is known. `failed` once the server said this person cannot see it. */
export function usePictureUrl(chatId: string, id: string): { url: string | null; failed: boolean } {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    listeners.add(rerender);
    return () => void listeners.delete(rerender);
  }, []);
  const hit = known.get(id);
  const fresh = !!hit && hit.until > Date.now();
  const failed = missing.has(id);
  useEffect(() => {
    if (!fresh && !failed) request(chatId, id);
  }, [chatId, id, fresh, failed]);
  return { url: fresh ? hit.url : null, failed };
}
