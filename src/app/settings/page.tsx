import Link from "next/link";
import { ApiKeyCards } from "@/components/api-key-cards";

export default function SettingsPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <header className="flex items-center gap-3">
        <Link href="/" className="text-sm underline">
          ← Chats
        </Link>
        <h1 className="text-2xl font-semibold">API keys</h1>
      </header>
      <p className="text-sm text-neutral-500">
        The AI answers your messages with your own key, so you pay your provider directly. Keys are encrypted on the
        server and can&apos;t be viewed again after saving. Other people in your chats never see them.
      </p>
      <ApiKeyCards />
    </main>
  );
}
