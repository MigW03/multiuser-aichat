import type { KeyHint, ProviderId } from "@mc/shared";
import { decrypt, encrypt } from "./crypto.ts";
import { admin } from "./supabase.ts";

// user_api_keys has RLS on and no client grants: only this server reads or writes it.
// Keys are write-only from the client's point of view; the API returns the last 4 characters at most.

export async function listKeyHints(userId: string): Promise<KeyHint[]> {
  const { data, error } = await admin.from("user_api_keys").select("provider, key_hint").eq("user_id", userId);
  if (error) throw new Error("Could not load your keys");
  return (data ?? []).map((r) => ({ provider: r.provider as ProviderId, hint: r.key_hint as string }));
}

export async function getUserKey(userId: string, provider: ProviderId): Promise<string | null> {
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
  await admin.from("user_api_keys").delete().eq("user_id", userId).eq("provider", provider);
}
