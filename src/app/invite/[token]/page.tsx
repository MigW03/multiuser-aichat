import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Authenticated page: the proxy sends signed-out visitors to sign-up and back here afterwards.
export const instant = false;

// Joining is an explicit click, not a side effect of opening the link, so link previews and
// prefetches can never add someone to a chat.
async function join(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accept_chat_invite", { p_token: token });
  if (error || !data) {
    redirect(`/invite/${encodeURIComponent(token)}?error=${encodeURIComponent(error?.message ?? "Could not join the chat")}`);
  }
  redirect(`/chat/${data}`);
}

export default async function InvitePage({ params, searchParams }: PageProps<"/invite/[token]">) {
  await connection();
  const { token } = await params;
  const { error } = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.rpc("preview_chat_invite", { p_token: token });
  const invite = data?.[0];

  if (invite?.status === "member" && invite.chat_id) redirect(`/chat/${invite.chat_id}`);

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 p-6">
      {invite?.status === "valid" ? (
        <>
          <h1 className="text-2xl font-semibold">Join &ldquo;{invite.chat_title}&rdquo;</h1>
          <p className="text-sm text-neutral-500">
            {invite.inviter_name} invited you to this chat. Everyone in it, and the AI, will see the messages you send.
          </p>
          {typeof error === "string" && <p className="text-sm text-red-600">{error}</p>}
          <form action={join} className="flex items-center gap-4">
            <input type="hidden" name="token" value={token} />
            <button className="rounded-md bg-foreground px-4 py-2 text-background">Join chat</button>
            <Link href="/" className="text-sm underline">
              Not now
            </Link>
          </form>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold">
            {invite?.status === "full"
              ? "This chat is full"
              : invite?.status === "expired"
                ? "This invite link has expired"
                : "This invite link isn't valid"}
          </h1>
          <p className="text-sm text-neutral-500">
            {invite?.status === "full"
              ? "It already has the maximum number of members."
              : "Ask the person who shared it for a new link."}
          </p>
          <Link href="/" className="text-sm underline">
            Go to your chats
          </Link>
        </>
      )}
    </main>
  );
}
