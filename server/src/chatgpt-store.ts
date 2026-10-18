import type { LoginStore } from "./chatgpt.ts";
import { admin } from "./supabase.ts";

// user_chatgpt_auth has RLS on and no client grants: only this server reads or writes it.

export const supabaseLoginStore: LoginStore = {
  async get(userId) {
    const { data } = await admin.from("user_chatgpt_auth").select("ciphertext, expires_at, hint").eq("user_id", userId).maybeSingle();
    return data ? { ciphertext: data.ciphertext as string, expiresAt: data.expires_at as string, hint: data.hint as string } : null;
  },

  async put(userId, login) {
    const { error } = await admin.from("user_chatgpt_auth").upsert({
      user_id: userId,
      ciphertext: login.ciphertext,
      expires_at: login.expiresAt,
      hint: login.hint,
      refreshing_until: null,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      console.error("[chatgpt] could not save the sign-in:", error.message); // database message only, never tokens
      throw new Error("Could not save the ChatGPT sign-in");
    }
  },

  async claimRefresh(userId, leaseSeconds) {
    const now = new Date();
    // One UPDATE decides the winner: it only matches while nobody holds a live lease.
    const { data, error } = await admin
      .from("user_chatgpt_auth")
      .update({ refreshing_until: new Date(now.getTime() + leaseSeconds * 1000).toISOString() })
      .eq("user_id", userId)
      .or(`refreshing_until.is.null,refreshing_until.lt.${now.toISOString()}`)
      .select("user_id");
    return !error && (data?.length ?? 0) > 0;
  },

  async release(userId) {
    await admin.from("user_chatgpt_auth").update({ refreshing_until: null }).eq("user_id", userId);
  },

  async delete(userId) {
    await admin.from("user_chatgpt_auth").delete().eq("user_id", userId);
  },
};
