import type { ClaudeCodeUsage, ClaudeCodeUsageWindow } from "@mc/shared";

// What the person's own `claude` says about their Claude plan limits. Two sources, both from `claude` itself through the public
// Agent SDK (Nido never reads the saved login and never calls Anthropic's usage endpoint):
//  - `rate_limit_event` messages that `claude` sends while it answers (free, stable type);
//  - the answer to asking it directly for the data behind /usage (experimental in the SDK, so it may stop working).

const LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly Opus",
  seven_day_sonnet: "Weekly Sonnet",
  seven_day_overage_included: "Weekly (extra included)",
  overage: "Extra usage",
};
const ORDER = Object.keys(LABELS);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clampPercent = (v: number | null): number | null => (v === null ? null : Math.min(100, Math.max(0, v)));
/** The SDK's `utilization` on a rate-limit event is a fraction of the window (0 to 1), like its `surpassedThreshold`; the /usage answer says 0-100. */
export const fractionToPercent = (v: number | null): number | null => clampPercent(v === null ? null : v * 100);
const iso = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.round(t / 1000);
};

/** Keeps the latest word from `claude` about each limit window. Memory only: it starts empty when the app starts. */
export class UsageTracker {
  private windows = new Map<string, ClaudeCodeUsageWindow>();
  private plan: string | null = null;
  /** The latest status `claude` gave for each window ("_" when it named none). */
  private statuses = new Map<string, "allowed" | "allowed_warning" | "rejected">();
  private extra: ClaudeCodeUsage["extra"] = null;
  private source: ClaudeCodeUsage["source"] | null = null;
  private fetchedAt = 0;

  clear() {
    this.windows.clear();
    this.plan = null;
    this.statuses.clear();
    this.extra = null;
    this.source = null;
    this.fetchedAt = 0;
  }

  /** A `rate_limit_event`'s `rate_limit_info`. Returns whether anything changed. */
  applyEvent(info: unknown, now = Date.now()): boolean {
    if (!info || typeof info !== "object") return false;
    const i = info as { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown; utilization?: unknown; overageEnabled?: unknown };
    const key = typeof i.rateLimitType === "string" && i.rateLimitType in LABELS ? i.rateLimitType : null;
    const status = i.status === "allowed" || i.status === "allowed_warning" || i.status === "rejected" ? i.status : null;
    if (!key && !status) return false;
    if (key) {
      const prev = this.windows.get(key);
      const used = fractionToPercent(num(i.utilization));
      this.windows.set(key, { key, label: LABELS[key]!, usedPercent: used ?? prev?.usedPercent ?? (status === "rejected" ? 100 : null), resetsAt: num(i.resetsAt) ?? prev?.resetsAt ?? null });
    }
    if (status) this.statuses.set(key ?? "_", status);
    this.source ??= "events";
    this.fetchedAt = now;
    return true;
  }

  /** The answer to the direct question (the data behind /usage). It replaces what the events said. */
  applyUsage(res: unknown, now = Date.now()): boolean {
    if (!res || typeof res !== "object") return false;
    const r = res as { subscription_type?: unknown; rate_limits_available?: unknown; rate_limits?: Record<string, unknown> | null };
    if (r.rate_limits_available !== true || !r.rate_limits || typeof r.rate_limits !== "object") return false;
    const next = new Map<string, ClaudeCodeUsageWindow>();
    for (const key of ORDER) {
      if (key === "overage") continue;
      const w = (r.rate_limits as Record<string, unknown>)[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
      if (!w || typeof w !== "object") continue;
      next.set(key, { key, label: LABELS[key]!, usedPercent: clampPercent(num(w.utilization)), resetsAt: iso(w.resets_at) });
    }
    const scoped = (r.rate_limits as { model_scoped?: unknown }).model_scoped;
    if (Array.isArray(scoped)) {
      for (const m of scoped.slice(0, 8) as { display_name?: unknown; utilization?: unknown; resets_at?: unknown }[]) {
        const name = typeof m?.display_name === "string" ? m.display_name.replace(/[^\x20-\x7e]/g, "").slice(0, 40).trim() : "";
        if (name) next.set(`model:${name}`, { key: `model:${name}`, label: `Weekly ${name}`, usedPercent: clampPercent(num(m.utilization)), resetsAt: iso(m.resets_at) });
      }
    }
    const e = (r.rate_limits as { extra_usage?: { is_enabled?: unknown; monthly_limit?: unknown; used_credits?: unknown; currency?: unknown } | null }).extra_usage;
    // Amounts come in minor units (cents); the page shows major units.
    this.extra = e && typeof e === "object" ? { enabled: e.is_enabled === true, used: num(e.used_credits) === null ? null : num(e.used_credits)! / 100, limit: num(e.monthly_limit) === null ? null : num(e.monthly_limit)! / 100, currency: typeof e.currency === "string" && /^[A-Za-z]{3}$/.test(e.currency) ? e.currency.toUpperCase() : null } : null;
    this.windows = next;
    this.plan = typeof r.subscription_type === "string" ? r.subscription_type.replace(/[^\x20-\x7e]/g, "").slice(0, 30) || null : this.plan;
    this.statuses.clear();
    for (const w of next.values()) if (w.usedPercent !== null && w.usedPercent >= 100) this.statuses.set(w.key, "rejected");
    this.source = "usage";
    this.fetchedAt = now;
    return true;
  }

  snapshot(): ClaudeCodeUsage | null {
    if (!this.source) return null;
    const windows = [...this.windows.values()].sort((a, b) => (ORDER.indexOf(a.key) === -1 ? 99 : ORDER.indexOf(a.key)) - (ORDER.indexOf(b.key) === -1 ? 99 : ORDER.indexOf(b.key)));
    const all = [...this.statuses.values()];
    const reached = all.includes("rejected");
    return { plan: this.plan, windows, reached, warning: !reached && all.includes("allowed_warning"), extra: this.extra, source: this.source, fetchedAt: this.fetchedAt };
  }
}
