import Link from "next/link";

export default function Loading() {
  return (
    <div className="mx-auto flex h-dvh w-full max-w-3xl flex-col" aria-busy="true">
      <header className="flex items-center gap-3 border-b border-neutral-200 p-4 dark:border-neutral-800">
        <Link href="/" className="text-sm underline">
          ← Chats
        </Link>
        <div className="h-5 w-32 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
      </header>

      <div className="flex flex-1 animate-pulse flex-col justify-end gap-3 p-4">
        <div className="h-10 w-2/5 self-start rounded-2xl bg-neutral-200 dark:bg-neutral-800" />
        <div className="h-10 w-1/3 self-end rounded-2xl bg-neutral-200 dark:bg-neutral-800" />
        <div className="h-16 w-3/5 self-start rounded-2xl bg-neutral-200 dark:bg-neutral-800" />
      </div>

      <div className="h-5" />
      <div className="flex flex-col gap-2 border-t border-neutral-200 p-4 dark:border-neutral-800">
        <div className="h-6 w-28 self-end rounded-md bg-neutral-200 dark:bg-neutral-800" />
        <div className="flex gap-2">
          <div className="h-10 flex-1 rounded-md border border-neutral-300 dark:border-neutral-700" />
          <div className="h-10 w-16 rounded-md bg-neutral-200 dark:bg-neutral-800" />
        </div>
      </div>
    </div>
  );
}
