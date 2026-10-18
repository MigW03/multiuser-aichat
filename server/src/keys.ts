import type { KeyHint, ProviderId } from "@mc/shared";
import { disconnect, getAccessToken } from "./chatgpt.ts";
import { supabaseLoginStore } from "./chatgpt-store.ts";
import { decrypt, encrypt } from "./crypto.ts";
import { forgetOpenRouterUsage } from "./openrouter-usage.ts";
import { admin } from "./supabase.ts";

// user_api_keys has RLS on and no client grants: only this server reads or writes it.
// Keys are write-only from the client's point of view; the API returns the last 4 characters at most.
// A ChatGPT plan is not a key: its sign-in lives in user_chatgpt_auth (see chatgpt.ts) and shows up here as the
// "key" of the provider "chatgpt", whose hint is a masked account label.

export async function listKeyHints(userId: string): Promise<KeyHint[]> {
  const [keys, plan] = await Promise.all([
    admin.from("user_api_keys").select("provider, key_hint").eq("user_id", userId),
    admin.from("user_chatgpt_auth").select("hint").eq("user_id", userId).maybeSingle(),
  ]);
  if (keys.error) throw new Error("Could not load your keys");
  // A broken ChatGPT plan lookup (for example the migration is not applied yet) must not hide the API keys.
  if (plan.error) console.error("[keys] could not read the ChatGPT plan sign-in:", plan.error.message);
  const hints = (keys.data ?? []).map((r) => ({ provider: r.provider as ProviderId, hint: r.key_hint as string }));
  if (plan.data) hints.push({ provider: "chatgpt", hint: plan.data.hint as string });
  return hints;
}

/** The credential to call `provider` with: an API key, or for ChatGPT plan a fresh access token. Null when not connected. */
export async function getUserKey(userId: string, provider: ProviderId): Promise<string | null> {
  if (provider === "chatgpt") return getAccessToken(supabaseLoginStore, userId);
  const { data } = await admin
    .from("user_api_keys")
    .select("ciphertext")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (!data) return null;
  try {
    return decrypt(data.ciphertext as string);
  } catch {
    return null; // encrypted with a different secret: treat as missing so the user re-enters it
  }
}

export async function saveUserKey(userId: string, provider: ProviderId, apiKey: string): Promise<string> {
  const hint = apiKey.slice(-4);
  if (provider === "openrouter") forgetOpenRouterUsage(userId); // a new key has its own numbers
  const { error } = await admin.from("user_api_keys").upsert({
    user_id: userId,
    provider,
    ciphertext: encrypt(apiKey),
    key_hint: hint,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error("Could not save the key");
  return hint;
}

export async function deleteUserKey(userId: string, provider: ProviderId): Promise<void> {
  if (provider === "chatgpt") return disconnect(supabaseLoginStore, userId);
  if (provider === "openrouter") forgetOpenRouterUsage(userId);
  await admin.from("user_api_keys").delete().eq("user_id", userId).eq("provider", provider);
}
