export default function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 animate-pulse flex-col gap-6 p-6" aria-busy="true">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your chats</h1>
        <div className="h-4 w-14 rounded bg-neutral-200 dark:bg-neutral-800" />
      </header>
      <div className="h-10 w-24 rounded-md bg-neutral-200 dark:bg-neutral-800" />
      <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
        {Array.from({ length: 4 }, (_, i) => (
          <li key={i} className="flex justify-between py-3">
            <div className="h-5 w-40 rounded bg-neutral-200 dark:bg-neutral-800" />
            <div className="h-4 w-20 rounded bg-neutral-200 dark:bg-neutral-800" />
          </li>
        ))}
      </ul>
    </main>
  );
}
