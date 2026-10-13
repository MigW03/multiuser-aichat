"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PROVIDER_IDS, PROVIDER_KEY_URLS, PROVIDER_LABELS, type ProviderId } from "@/lib/ai/provider-meta";

type Hints = Partial<Record<ProviderId, string>>;

export default function SettingsPage() {
  const [hints, setHints] = useState<Hints | null>(null); // provider -> last 4 characters; null while loading

  useEffect(() => {
    void fetch("/api/keys")
      .then((r) => r.json())
      .then((d: { keys?: { provider: ProviderId; hint: string }[] }) =>
        setHints(Object.fromEntries((d.keys ?? []).map((k) => [k.provider, k.hint]))),
      )
      .catch(() => setHints({}));
  }, []);

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
      <div className="flex flex-col gap-4">
        {PROVIDER_IDS.map((provider) => (
          <KeyCard
            key={provider}
            provider={provider}
            hint={hints?.[provider]}
            loading={hints === null}
            onChange={(hint) => setHints((h) => ({ ...h, [provider]: hint }))}
          />
        ))}
      </div>
    </main>
  );
}

function KeyCard(props: {
  provider: ProviderId;
  hint: string | undefined;
  loading: boolean;
  onChange: (hint: string | undefined) => void;
}) {
  const { provider } = props;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<"saving" | "removing" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy("saving");
    setError(null);
    try {
      const res = await fetch("/api/keys", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, key: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setError(data.error ?? "Could not save the key.");
      setValue("");
      props.onChange(data.hint);
    } catch {
      setError("Could not save the key.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("removing");
    setError(null);
    try {
      const res = await fetch(`/api/keys?provider=${provider}`, { method: "DELETE" });
      if (!res.ok) return setError("Could not remove the key.");
      props.onChange(undefined);
    } catch {
      setError("Could not remove the key.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{PROVIDER_LABELS[provider]}</h2>
        {!props.loading && <span className="text-sm text-neutral-500">{props.hint ? "Key saved" : "Not set"}</span>}
      </div>

      {props.loading ? (
        <div className="h-10 animate-pulse rounded-md bg-neutral-200 dark:bg-neutral-800" />
      ) : props.hint ? (
        // One key per provider: to change it, remove it and add the new one.
        <div className="flex items-center justify-between gap-3 rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700">
          <span className="font-mono text-sm" aria-label={`Saved key ending in ${props.hint}`}>
            ••••••••••••{props.hint}
          </span>
          <button onClick={remove} disabled={busy !== null} className="text-sm underline disabled:opacity-50">
            {busy === "removing" ? "Removing…" : "Remove"}
          </button>
        </div>
      ) : (
        <>
          <form onSubmit={save} className="flex gap-2">
            <input
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Paste your API key"
              aria-label={`${PROVIDER_LABELS[provider]} API key`}
              className="flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
            />
            <button
              disabled={busy !== null || value.trim().length < 8}
              className="rounded-md bg-foreground px-3 py-2 text-background disabled:opacity-50"
            >
              {busy === "saving" ? "Checking…" : "Save"}
            </button>
          </form>
          <a
            href={PROVIDER_KEY_URLS[provider]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-neutral-500 underline"
          >
            Get a {PROVIDER_LABELS[provider]} key
          </a>
        </>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}
