import type { ProviderId } from "@mc/shared";
import { notifyChanged } from "../data.tsx";
import { supabase } from "../supabase.ts";

/** Pins or unpins a chat for the signed-in person only. */
export async function setPinned(chatId: string, userId: string, pinned: boolean): Promise<boolean> {
  const { error } = pinned
    ? await supabase.from("chat_pins").upsert({ user_id: userId, chat_id: chatId }, { onConflict: "user_id,chat_id", ignoreDuplicates: true })
    : await supabase.from("chat_pins").delete().eq("user_id", userId).eq("chat_id", chatId);
  if (!error) notifyChanged();
  return !error;
}

/** Stars or unstars a model for the signed-in person only. RLS limits every row to its owner. */
export async function setFavoriteModel(userId: string, provider: ProviderId, model: string, starred: boolean): Promise<boolean> {
  const { error } = starred
    ? await supabase.from("user_favorite_models").upsert({ user_id: userId, provider, model }, { onConflict: "user_id,provider,model", ignoreDuplicates: true })
    : await supabase.from("user_favorite_models").delete().eq("user_id", userId).eq("provider", provider).eq("model", model);
  return !error;
}

export async function fetchFavoriteModels(userId: string, provider: ProviderId): Promise<string[]> {
  const { data, error } = await supabase.from("user_favorite_models").select("model").eq("user_id", userId).eq("provider", provider).order("created_at");
  if (error || !data) throw new Error("Could not load your starred models.");
  return data.map((r) => r.model);
}

/** Copies text to the clipboard. Falls back to a hidden textarea where the clipboard API is missing or refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return legacyCopy(text);
  }
}

function legacyCopy(text: string): boolean {
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(el);
  try {
    el.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    el.remove();
    active?.focus();
  }
}
