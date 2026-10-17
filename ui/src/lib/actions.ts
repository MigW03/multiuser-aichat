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

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
