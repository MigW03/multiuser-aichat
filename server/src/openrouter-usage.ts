import type { OpenRouterUsage } from "@mc/shared";
import { ProviderError } from "./provider-error.ts";

// How much of an OpenRouter key's budget is used, for the ring beside the model picker. OpenRouter's documented
// GET /api/v1/key reports it for the key being used, so it needs no extra permission. The account-wide balance
// (GET /api/v1/credits) needs a management key, so it is only tried when the key has no budget, and ignored if refused.

const BASE = "https://openrouter.ai/api/v1";
const CACHE_MS = 45_000;
const CACHE_MAX = 256;
const cache = new Map<string, OpenRouterUsage>();

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const interval = (v: unknown): string | null => (typeof v === "string" && /^[a-z_]{1,20}$/.test(v) ? v : null);
const unixSeconds = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

/** Only these numbers leave this function. The key's label (which can hold part of the key) and the rest are dropped. */
export function normalizeKeyUsage(payload: unknown, credits: { total: number; used: number } | null, now = Date.now()): OpenRouterUsage {
  const d = obj(obj(payload).data);
  const eff = obj(d.effective_budget);
  const effLimit = num(eff.limit_usd);
  const keyLimit = num(d.limit);
  let budget: OpenRouterUsage["budget"] = null;
  if (effLimit !== null && effLimit > 0) {
    budget = { limit: effLimit, spent: num(eff.spend_usd) ?? 0, remaining: num(eff.remaining_usd), resetInterval: interval(eff.reset_interval), resetsAt: unixSeconds(eff.resets_at) };
  } else if (keyLimit !== null && keyLimit > 0) {
    const spent = num(d.usage) ?? 0;
    budget = { limit: keyLimit, spent, remaining: num(d.limit_remaining) ?? Math.max(0, keyLimit - spent), resetInterval: interval(d.limit_reset), resetsAt: null };
  }
  return {
    budget,
    spend: { day: num(d.usage_daily) ?? 0, week: num(d.usage_weekly) ?? 0, month: num(d.usage_monthly) ?? 0, total: num(d.usage) ?? 0 },
    credits,
    fetchedAt: now,
  };
}

async function get(path: string, apiKey: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
}

/** This user's own key usage, cached for a short while. Throws ProviderError with a message safe to show. */
export async function getOpenRouterUsage(userId: string, apiKey: string, refresh = false): Promise<OpenRouterUsage> {
  const cached = cache.get(userId);
  if (cached && !refresh && Date.now() - cached.fetchedAt < CACHE_MS) return cached;
  let res: Response;
  try {
    res = await get("/key", apiKey);
  } catch {
    throw new ProviderError("Could not reach OpenRouter. Try again in a moment.");
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError("OpenRouter rejected this key. Update it in Settings.");
  if (res.status === 429) throw new ProviderError("OpenRouter is limiting usage checks for a moment. Try again shortly.");
  if (!res.ok) throw new ProviderError(`OpenRouter could not report usage (${res.status}).`);
  const json = await res.json().catch(() => null);
  if (!json || typeof json !== "object") throw new ProviderError("OpenRouter sent an unexpected usage response.");

  let credits: { total: number; used: number } | null = null;
  const first = normalizeKeyUsage(json, null);
  if (!first.budget) {
    try {
      const r = await get("/credits", apiKey);
      if (r.ok) {
        const c = obj(obj(await r.json().catch(() => null)).data);
        const total = num(c.total_credits);
        const used = num(c.total_usage);
        if (total !== null && used !== null && total >= 0) credits = { total, used };
      }
    } catch {
      /* the balance is a bonus: a normal key is refused, and that is fine */
    }
  }
  const usage = { ...first, credits };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(userId, usage);
  return usage;
}

export function forgetOpenRouterUsage(userId: string): void {
  cache.delete(userId);
}
