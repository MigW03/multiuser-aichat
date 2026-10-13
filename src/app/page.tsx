import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Authenticated page: reads the session per request instead of prerendering a shell.
export const instant = false;

async function createChat() {
  "use server";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_chat", { p_title: "New chat" });
  if (error || !data) throw new Error(error?.message ?? "Could not create chat");
  redirect(`/chat/${data}`);
}

async function signOut() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export default async function Home() {
  await connection();
  const supabase = await createClient();
  const { data: chats } = await supabase.from("chats").select("id, title, created_at").order("created_at", { ascending: false });

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your chats</h1>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/settings" className="underline">
            API keys
          </Link>
          <form action={signOut}>
            <button className="underline">Sign out</button>
          </form>
        </div>
      </header>
      <form action={createChat}>
        <button className="rounded-md bg-foreground px-3 py-2 text-background">New chat</button>
      </form>
      <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
        {chats?.map((c) => (
          <li key={c.id}>
            <Link href={`/chat/${c.id}`} className="flex justify-between py-3 hover:underline">
              <span>{c.title}</span>
              <span className="text-sm text-neutral-500">{new Date(c.created_at).toLocaleDateString()}</span>
            </Link>
          </li>
        ))}
        {!chats?.length && <li className="py-3 text-neutral-500">No chats yet.</li>}
      </ul>
    </main>
  );
}
