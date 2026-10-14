"use client";

import { Suspense, useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiKeyCards, type KeyHints } from "@/components/api-key-cards";
import { safeNext } from "@/lib/safe-next";

// First stop after sign-up: add an AI key now, or skip and do it later from Settings.
export default function WelcomePage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <p className="text-sm text-neutral-500">Step 1 of 1</p>
        <h1 className="text-2xl font-semibold">Connect your AI</h1>
        <p className="text-sm text-neutral-500">
          The AI answers your messages with your own API key, so you pay your provider directly. Add a key for at
          least one provider to chat with the AI. Keys are encrypted and other people never see them.
        </p>
      </header>
      <Suspense fallback={null}>
        <Steps />
      </Suspense>
    </main>
  );
}

function Steps() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const [saved, setSaved] = useState(0);
  const onHintsChange = useCallback((hints: KeyHints) => setSaved(Object.values(hints).filter(Boolean).length), []);

  const go = () => router.replace(next);

  return (
    <>
      <ApiKeyCards onHintsChange={onHintsChange} />
      <div className="flex flex-wrap items-center justify-end gap-4">
        <span className="mr-auto text-sm text-neutral-500">You can add or change keys later under &ldquo;API keys&rdquo;.</span>
        {saved === 0 && (
          <button onClick={go} className="text-sm underline">
            Skip for now
          </button>
        )}
        <button
          onClick={go}
          disabled={saved === 0}
          className="rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
        >
          Continue
        </button>
      </div>
    </>
  );
}
