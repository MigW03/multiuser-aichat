import { connection } from "next/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ChatRoom, type ChatMessage, type Member } from "@/components/chat-room";
import type { ModelChoice } from "@/components/model-picker";
import { listKeyHints } from "@/lib/ai/keys";
import { isProvider } from "@/lib/ai/provider-meta";

export const instant = false;

export default async function ChatPage({ params }: PageProps<"/chat/[id]">) {
  await connection();
  const { id } = await params;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getClaims();
  const userId = auth?.claims?.sub;
  if (!userId) notFound();

  const { data: chat } = await supabase.from("chats").select("id, title").eq("id", id).maybeSingle();
  if (!chat) notFound();

  const [{ data: messages }, { data: members }, { data: profile }, { data: membership }, { data: favorites }, keys] = await Promise.all([
    supabase.from("messages").select("id, author_id, role, content, status, seq, provider, model").eq("chat_id", id).order("seq"),
    supabase.from("chat_members").select("profiles(id, display_name)").eq("chat_id", id),
    supabase.from("profiles").select("ai_provider, ai_model").eq("id", userId).maybeSingle(),
    supabase.from("chat_members").select("ai_provider, ai_model").eq("chat_id", id).eq("user_id", userId).maybeSingle(),
    supabase.from("user_favorite_models").select("provider, model").order("created_at"),
    listKeyHints(userId),
  ]);

  const memberList = (members ?? [])
    .map((m) => m.profiles as unknown as Member | null)
    .filter((p): p is Member => !!p);

  // This chat's saved model first; a chat nobody has picked in yet starts from the user's latest pick anywhere.
  const saved = [membership, profile].find((r) => isProvider(r?.ai_provider) && r?.ai_model);
  const initialChoice: ModelChoice | null = saved ? { provider: saved.ai_provider as ModelChoice["provider"], model: saved.ai_model as string } : null;

  return (
    <ChatRoom
      chatId={chat.id}
      title={chat.title}
      userId={userId}
      initialMessages={(messages ?? []) as ChatMessage[]}
      initialMembers={memberList}
      providers={keys.map((k) => k.provider)}
      initialFavorites={(favorites ?? []).filter((f): f is ModelChoice => isProvider(f.provider))}
      initialChoice={initialChoice}
    />
  );
}
