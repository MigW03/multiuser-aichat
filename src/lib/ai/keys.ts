import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt, encrypt } from "@/lib/crypto";
import type { ProviderId } from "@/lib/ai/providers";

// Server-only. Keys live in user_api_keys, which only the service role can touch.

export async function listKeyHints(userId: string): Promise<{ provider: ProviderId; hint: string }[]> {
  const { data } = await createAdminClient().from("user_api_keys").select("provider, key_hint").eq("user_id", userId);
  return (data ?? []).map((r) => ({ provider: r.provider as ProviderId, hint: r.key_hint }));
}

export async function getUserKey(userId: string, provider: ProviderId): Promise<string | null> {
  const { data } = await createAdminClient()
    .from("user_api_keys")
    .select("ciphertext")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  return data ? decrypt(data.ciphertext) : null;
}

export async function saveUserKey(userId: string, provider: ProviderId, apiKey: string): Promise<string> {
  const hint = apiKey.slice(-4);
  const { error } = await createAdminClient()
    .from("user_api_keys")
    .upsert({ user_id: userId, provider, ciphertext: encrypt(apiKey), key_hint: hint, updated_at: new Date().toISOString() });
  if (error) throw new Error("Could not save the key");
  return hint;
}

export async function deleteUserKey(userId: string, provider: ProviderId) {
  await createAdminClient().from("user_api_keys").delete().eq("user_id", userId).eq("provider", provider);
}
