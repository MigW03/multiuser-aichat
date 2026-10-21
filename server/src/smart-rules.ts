import { isSmartModel, LIMITS, SMART_MODEL_ID, type OpenRouterUsage } from "@mc/shared";

// The rules of Smart model selection that need no database or network, so they can be tested alone.

/**
 * The part of the request that asks OpenRouter's Jev Router to choose among `models`. It goes in the OpenRouter provider
 * options, which the OpenAI-compatible provider puts in the request body. The router ignores a list that matches nothing
 * (and then picks from everything), so callers pass only a checked set (see cleanSmartSet).
 */
export function smartProviderOptions(models: string[]) {
  return { openrouter: { plugins: [{ id: "jev-router", models }] } };
}

/** A Smart set as it may be saved: valid model ids, no repeats, never the router itself. Null when something is off. */
export function cleanSmartSet(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length > LIMITS.smartMax) return null;
  const out: string[] = [];
  for (const m of input) {
    if (typeof m !== "string" || !LIMITS.modelIdPattern.test(m) || isSmartModel(m)) return null;
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

/**
 * What a key's usage numbers say about credit. A normal OpenRouter key can only see its own spending cap, so "no credits" is
 * claimed only when OpenRouter shows zero left (the cap, or the account balance when it may be read). Otherwise it is
 * "ok", and a key that really is empty is caught when OpenRouter refuses the request (402).
 */
export function creditStatus(usage: Pick<OpenRouterUsage, "budget" | "credits">): "ok" | "no_credits" {
  if (usage.budget && usage.budget.remaining !== null && usage.budget.remaining <= 0) return "no_credits";
  if (usage.credits && usage.credits.total - usage.credits.used <= 0) return "no_credits";
  return "ok";
}

/** The model that really answered, as OpenRouter reports it. Anything that is not a plain model id (or is the router itself) is dropped. */
export function answeredBy(modelId: unknown): string | null {
  return typeof modelId === "string" && LIMITS.modelIdPattern.test(modelId) && modelId !== SMART_MODEL_ID ? modelId : null;
}
