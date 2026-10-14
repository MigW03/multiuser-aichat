"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Member = { id: string; display_name: string };
type InviteLink = { url: string; expiresAt: string };

/** "Sharing" button in the chat's top bar: who's in the chat, the invite link, and invite by email. */
export function SharingMenu(props: { chatId: string; members: Member[]; onMembersChanged: () => Promise<void> }) {
  const { chatId, members } = props;
  const supabase = useMemo(() => createClient(), []);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const [link, setLink] = useState<InviteLink | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkStatus, setLinkStatus] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailStatus, setEmailStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setLinkStatus("Copied to clipboard.");
    } catch {
      setLinkStatus("Couldn't copy automatically. Select the link above and copy it.");
    }
  }

  // The chat's current link, or a fresh one with `reset` (which makes the old link stop working). Copies it too.
  async function fetchLink(reset: boolean) {
    setLinkBusy(true);
    setLinkError(null);
    setLinkStatus(null);
    const { data, error } = await supabase.rpc(reset ? "reset_chat_invite_link" : "get_chat_invite_link", {
      p_chat_id: chatId,
    });
    setLinkBusy(false);
    const row = data?.[0] as { token: string; expires_at: string } | undefined;
    if (error || !row) return setLinkError(error?.message ?? "Could not create an invite link.");
    const next = { url: `${window.location.origin}/invite/${row.token}`, expiresAt: row.expires_at };
    setLink(next);
    await copy(next.url);
    if (reset) setLinkStatus("New link created and copied. The old link no longer works.");
  }

  async function inviteByEmail(e: React.FormEvent) {
    e.preventDefault();
    setEmailBusy(true);
    setEmailStatus(null);
    const { data, error } = await supabase.rpc("invite_to_chat", { p_chat_id: chatId, p_email: email });
    setEmailBusy(false);
    if (error) return setEmailStatus({ ok: false, text: error.message });
    setEmail("");
    setEmailStatus({ ok: true, text: `${data} was added to the chat.` });
    await props.onMembersChanged();
  }

  const expires = link && new Date(link.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="true"
        aria-expanded={open}
        className="flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700"
      >
        Sharing
        <span aria-hidden className="text-neutral-500">
          ▾
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-4 rounded-lg border border-neutral-200 bg-background p-4 text-sm shadow-lg dark:border-neutral-800">
          <section className="flex flex-col gap-1">
            <h2 className="font-medium">People in this chat</h2>
            <ul className="flex flex-col text-neutral-500">
              {members.map((m) => (
                <li key={m.id}>{m.display_name}</li>
              ))}
            </ul>
          </section>

          <section className="flex flex-col gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
            <h2 className="font-medium">Invite link</h2>
            {link ? (
              <>
                <p className="text-neutral-500">Anyone with this link can join until {expires}.</p>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={link.url}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-label="Invite link"
                    className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-transparent px-2 py-1 font-mono text-xs dark:border-neutral-700"
                  />
                  <button
                    type="button"
                    onClick={() => void copy(link.url)}
                    className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700"
                  >
                    Copy
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => void fetchLink(true)}
                  disabled={linkBusy}
                  className="self-start text-neutral-500 underline disabled:opacity-50"
                >
                  {linkBusy ? "Creating…" : "Reset link"}
                </button>
              </>
            ) : (
              <>
                <p className="text-neutral-500">Share a link to let someone join, even before they have an account.</p>
                <button
                  type="button"
                  onClick={() => void fetchLink(false)}
                  disabled={linkBusy}
                  className="self-start rounded-md bg-foreground px-3 py-1.5 text-background disabled:opacity-50"
                >
                  {linkBusy ? "Creating link…" : "Copy invite link"}
                </button>
              </>
            )}
            {linkStatus && <p className="text-neutral-500">{linkStatus}</p>}
            {linkError && <p className="text-red-600">{linkError}</p>}
          </section>

          <section className="flex flex-col gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
            <h2 className="font-medium">Invite by email</h2>
            <p className="text-neutral-500">For people who already have an account.</p>
            <form onSubmit={inviteByEmail} className="flex gap-2">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                aria-label="Email to invite"
                className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
              />
              <button
                disabled={emailBusy}
                className="rounded-md border border-neutral-300 px-2 py-1 disabled:opacity-50 dark:border-neutral-700"
              >
                {emailBusy ? "Inviting…" : "Invite"}
              </button>
            </form>
            {emailStatus && <p className={emailStatus.ok ? "text-neutral-500" : "text-red-600"}>{emailStatus.text}</p>}
          </section>
        </div>
      )}
    </div>
  );
}
