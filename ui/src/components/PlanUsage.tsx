import type { ChatGptUsage, UsageLimit } from "@mc/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { Button } from "./kit.tsx";

// How much of the signed-in ChatGPT plan's limits is used. Fetched from ChatGPT through our server and only ever
// shown to the plan's owner: in Settings as bars, and in the chat as a small ring beside the model picker.

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

export function usePlanUsage(enabled: boolean) {
  const [usage, setUsage] = useState<ChatGptUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    try {
      setUsage(await api.chatgptUsage(refresh));
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load(false);
    const id = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(id);
  }, [enabled, load]);

  return { usage, error, busy, load };
}

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
          {w.usedPercent !== null && (
            <div className="usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w.usedPercent)} aria-label={`${w.label} usage`}>
              <div className={`usage-fill ${w.usedPercent >= 90 ? "high" : ""}`} style={{ width: `${w.usedPercent}%` }} />
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function UsageBody({ usage, error, busy, load }: ReturnType<typeof usePlanUsage>) {
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
      <div>
        <Button size="sm" variant="ghost" busy={busy} onClick={() => void load(true)}>
          Refresh
        </Button>
      </div>
    </div>
  );
}

/** The usage block in Settings, under the connected account. */
export function PlanUsage() {
  return <UsageBody {...usePlanUsage(true)} />;
}

/** The most used of the ordinary limit's windows: the one that will stop the user first. */
function mostUsed(usage: ChatGptUsage | null): number | null {
  const values = (usage?.main.windows ?? []).map((w) => w.usedPercent).filter((p): p is number => p !== null);
  return values.length ? Math.max(...values) : null;
}

const R = 8;
const CIRC = 2 * Math.PI * R;

/** A small ring beside the model picker that fills as the ChatGPT plan's limit is used. Click for the details. */
export function UsageRing({ enabled, answering }: { enabled: boolean; answering: boolean }) {
  const state = usePlanUsage(enabled);
  // An answer just finished, so the plan has been used a bit more: look again right away.
  const wasAnswering = useRef(false);
  const { load } = state;
  useEffect(() => {
    if (enabled && wasAnswering.current && !answering) void load(true);
    wasAnswering.current = answering;
  }, [answering, enabled, load]);
  // The details open while the pointer (or keyboard focus) is on the ring, and close a moment after it leaves,
  // so the pointer can cross the small gap into the panel. A tap opens it on touch screens.
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hovered = useRef(false);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  if (!enabled) return null;
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

  const used = mostUsed(state.usage);
  const reached = state.usage?.main.reached === true || (used !== null && used >= 100);
  const tone = reached ? "full" : used !== null && used >= 80 ? "warn" : "";
  const label = used === null ? (state.error ? "Plan usage unavailable" : "Plan usage") : `Plan usage: ${Math.round(used)}% used`;
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
        <div className="popover above end usage-popover" role="dialog" aria-label="Plan usage">
          <UsageBody {...state} />
        </div>
      )}
    </div>
  );
}
