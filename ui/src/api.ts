import type { ApiError, KeysResponse, ModelsResponse, ProviderId, SendMessageRequest } from "@mc/shared";
import { config } from "./config.ts";
import { supabase } from "./supabase.ts";

/** Calls the chat server with the current session's access token. Throws with a message safe to show. */
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("You are signed out.");
  let res: Response;
  try {
    res = await fetch(`${config.serverUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Could not reach the chat server. Is it running?");
  }
  const json = (await res.json().catch(() => ({}))) as T & Partial<ApiError>;
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

export const api = {
  sendMessage: (chatId: string, body: SendMessageRequest) => call<{ id: string }>("POST", `/api/chats/${chatId}/messages`, body),
  keys: () => call<KeysResponse>("GET", "/api/keys"),
  saveKey: (provider: ProviderId, apiKey: string) => call<{ hint: string }>("PUT", `/api/keys/${provider}`, { apiKey }),
  deleteKey: (provider: ProviderId) => call<{ ok: true }>("DELETE", `/api/keys/${provider}`),
  models: (provider: ProviderId) => call<ModelsResponse>("GET", `/api/models/${provider}`),
};
