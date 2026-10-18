import type { ChatGptUsage, OpenRouterUsage, ProviderId, UsageLimit } from "@mc/shared";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { Button } from "./kit.tsx";

// How much of the signed-in ChatGPT plan, or of the OpenRouter key's budget, is used. Fetched through our server and
// only ever shown to the account's owner: in Settings as bars, and in the chat as a small ring beside the model picker.

const POLL_MS = 60_000;

/** "in 2h 10m", "in 3d 4h": how long until a limit window resets. */
export function resetsIn(unixSeconds: number): string {
  const minutes = Math.max(0, Math.round((unixSeconds * 1000 - Date.now()) / 60_000));
  if (minutes < 1) return "now";
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return `in ${d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`}`;
}

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : "Something went wrong. Try again.");

const money = (n: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: n >= 100 ? 0 : 2 }).format(n);

/** Fetches a usage report now and every minute while `enabled`. `load(true)` skips the server's short cache. */
function useUsage<T>(fetcher: (refresh: boolean) => Promise<T>, enabled: boolean) {
  const [usage, setUsage] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (refresh: boolean) => {
      setBusy(true);
      try {
        setUsage(await fetcher(refresh));
        setError(null);
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setBusy(false);
      }
    },
    [fetcher],
  );

  useEffect(() => {
    if (!enabled) return;
    void load(false);
    const id = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(id);
  }, [enabled, load]);

  return { usage, error, busy, load };
}

const fetchChatGpt = (refresh: boolean) => api.chatgptUsage(refresh);
const fetchOpenRouter = (refresh: boolean) => api.openrouterUsage(refresh);
const usePlanUsage = (enabled: boolean) => useUsage<ChatGptUsage>(fetchChatGpt, enabled);
const useOpenRouterUsage = (enabled: boolean) => useUsage<OpenRouterUsage>(fetchOpenRouter, enabled);

type State<T> = ReturnType<typeof useUsage<T>>;

function Bar({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={label}>
      <div className={`usage-fill ${percent >= 90 ? "high" : ""}`} style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  );
}

function RefreshButton({ busy, load }: { busy: boolean; load: (refresh: boolean) => Promise<void> }) {
  return (
    <div>
      <Button size="sm" variant="ghost" busy={busy} onClick={() => void load(true)}>
        Refresh
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ ChatGPT plan

function UsageRows({ limit }: { limit: UsageLimit }) {
  return (
    <>
      {limit.name && (
        <div className="small muted">
          {limit.name}
          {limit.reached ? " · limit reached" : ""}
        </div>
      )}
      {limit.windows.map((w) => (
        <div key={w.label} className="usage-row">
          <div className="small">
            <b>{w.label}</b> · {w.usedPercent === null ? "usage unknown" : `${Math.round(w.usedPercent)}% used`}
            {w.resetsAt !== null && <span className="muted"> · resets {resetsIn(w.resetsAt)}</span>}
          </div>
          {w.usedPercent !== null && <Bar percent={w.usedPercent} label={`${w.label} usage`} />}
        </div>
      ))}
    </>
  );
}

function ChatGptBody({ usage, error, busy, load }: State<ChatGptUsage>) {
  if (error) return <div className="small muted">Usage unavailable: {error}</div>;
  if (!usage) return <div className="small muted">Checking your plan usage…</div>;
  return (
    <div className="usage">
      <div className="small muted">{usage.plan ? `${usage.plan[0]!.toUpperCase()}${usage.plan.slice(1)} plan · ` : ""}usage from ChatGPT</div>
      <UsageRows limit={usage.main} />
      {usage.extra.map((l, i) => (
        <UsageRows key={l.name ?? i} limit={l} />
      ))}
      {usage.main.windows.length === 0 && usage.extra.length === 0 && <div className="small muted">ChatGPT did not report any limits.</div>}
      <RefreshButton busy={busy} load={load} />
    </div>
  );
}

/** The most used of the ordinary limit's windows: the one that will stop the user first. */
function mostUsed(usage: ChatGptUsage | null): number | null {
  const values = (usage?.main.windows ?? []).map((w) => w.usedPercent).filter((p): p is number => p !== null);
  return values.length ? Math.max(...values) : null;
}

// ------------------------------------------------------------------ OpenRouter

/** "daily" -> "every day (UTC)". Only the intervals OpenRouter documents get a nicer name. */
const intervalText = (i: string) => ({ daily: "every day (UTC)", weekly: "every week (UTC)", monthly: "every month (UTC)" })[i] ?? i;

function OpenRouterBody({ usage, error, busy, load }: State<OpenRouterUsage>) {
  if (error) return <div className="small muted">Usage unavailable: {error}</div>;
  if (!usage) return <div className="small muted">Checking your key usage…</div>;
  const { budget, spend, credits } = usage;
  const budgetPercent = budget ? (budget.spent / budget.limit) * 100 : null;
  const creditsPercent = credits && credits.total > 0 ? (credits.used / credits.total) * 100 : null;
  return (
    <div className="usage">
      <div className="small muted">Your OpenRouter key · usage from OpenRouter</div>
      {budget && budgetPercent !== null ? (
        <div className="usage-row">
          <div className="small">
            <b>Key limit</b> · {money(budget.spent)} of {money(budget.limit)} used
            {budget.resetsAt !== null ? <span className="muted"> · resets {resetsIn(budget.resetsAt)}</span> : budget.resetInterval && <span className="muted"> · resets {intervalText(budget.resetInterval)}</span>}
          </div>
          <Bar percent={budgetPercent} label="Key limit usage" />
        </div>
      ) : (
        <div className="small muted">This key has no spending limit.</div>
      )}
      {credits && creditsPercent !== null && (
        <div className="usage-row">
          <div className="small">
            <b>Account credits</b> · {money(Math.max(0, credits.total - credits.used))} left of {money(credits.total)}
          </div>
          <Bar percent={creditsPercent} label="Account credits used" />
        </div>
      )}
      <div className="small">
        <b>Spent</b> · {money(spend.day)} today · {money(spend.week)} this week · {money(spend.month)} this month · {money(spend.total)} in total
      </div>
      <RefreshButton busy={busy} load={load} />
    </div>
  );
}

// ------------------------------------------------------------------ Settings

/** The ChatGPT usage block in Settings, under the connected account. */
export function PlanUsage() {
  return <ChatGptBody {...usePlanUsage(true)} />;
}

/** The OpenRouter usage block in Settings, under the saved key. */
export function OpenRouterKeyUsage() {
  return <OpenRouterBody {...useOpenRouterUsage(true)} />;
}

// ------------------------------------------------------------------ the ring

const R = 8;
const CIRC = 2 * Math.PI * R;

/**
 * A small free-standing ring that fills as the limit is used, with the details in a panel that stays open while the
 * pointer is over it. `used` null draws the empty track only (nothing to measure against).
 */
function Ring({ used, reached, label, answering, reload, children }: { used: number | null; reached: boolean; label: string; answering: boolean; reload: () => void; children: ReactNode }) {
  // An answer just finished, so something was used: look again right away.
  const wasAnswering = useRef(false);
  useEffect(() => {
    if (wasAnswering.current && !answering) reload();
    wasAnswering.current = answering;
  }, [answering, reload]);

  // The details open while the pointer (or keyboard focus) is on the ring, and close a moment after it leaves,
  // so the pointer can cross the small gap into the panel. A tap opens it on touch screens.
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hovered = useRef(false);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const show = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hideSoon = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 200);
  };
  // The pointer decides: while it is over the ring or the panel nothing closes it, not even focus moving away
  // (a button that disables itself while it works drops focus without the pointer going anywhere).
  const enter = () => {
    hovered.current = true;
    show();
  };
  const leave = () => {
    hovered.current = false;
    hideSoon();
  };
  const blur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!hovered.current && !e.currentTarget.contains(e.relatedTarget as Node | null)) hideSoon();
  };

  const tone = reached ? "full" : used !== null && used >= 80 ? "warn" : "";
  return (
    <div className="menu-wrap" onMouseEnter={enter} onMouseLeave={leave} onFocus={show} onBlur={blur} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button type="button" className="usage-ring-btn" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden>
          <circle className="usage-ring-track" cx="10" cy="10" r={R} fill="none" strokeWidth="2.5" />
          {used !== null && (
            <circle
              className={`usage-ring-arc ${tone}`}
              cx="10"
              cy="10"
              r={R}
              fill="none"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={`${(Math.min(100, Math.max(used, 2)) / 100) * CIRC} ${CIRC}`}
              transform="rotate(-90 10 10)"
            />
          )}
        </svg>
      </button>
      {open && (
        <div className="popover above end usage-popover" role="dialog" aria-label="Usage">
          {children}
        </div>
      )}
    </div>
  );
}

function ChatGptRing({ answering }: { answering: boolean }) {
  const state = usePlanUsage(true);
  const { load } = state;
  const used = mostUsed(state.usage);
  const label = used === null ? (state.error ? "Plan usage unavailable" : "Plan usage") : `Plan usage: ${Math.round(used)}% used`;
  return (
    <Ring used={used} reached={state.usage?.main.reached === true || (used !== null && used >= 100)} label={label} answering={answering} reload={() => void load(true)}>
      <ChatGptBody {...state} />
    </Ring>
  );
}

function OpenRouterRing({ answering }: { answering: boolean }) {
  const state = useOpenRouterUsage(true);
  const { load } = state;
  const u = state.usage;
  // The key's own cap if it has one, else the account balance if OpenRouter lets us read it, else nothing to measure.
  const used = u?.budget ? (u.budget.spent / u.budget.limit) * 100 : u?.credits && u.credits.total > 0 ? (u.credits.used / u.credits.total) * 100 : null;
  const label = used !== null ? `OpenRouter usage: ${Math.round(used)}% used` : u ? `OpenRouter spend: ${money(u.spend.total)}` : state.error ? "OpenRouter usage unavailable" : "OpenRouter usage";
  return (
    <Ring used={used} reached={used !== null && used >= 100} label={label} answering={answering} reload={() => void load(true)}>
      <OpenRouterBody {...state} />
    </Ring>
  );
}

/** The ring beside the model picker for the provider in use. Providers with no usage report show nothing. */
export function UsageRing({ provider, answering }: { provider: ProviderId | null; answering: boolean }) {
  if (provider === "chatgpt") return <ChatGptRing answering={answering} />;
  if (provider === "openrouter") return <OpenRouterRing answering={answering} />;
  return null;
}
