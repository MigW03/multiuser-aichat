import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { PROVIDER_LABELS, type ProviderId } from "@/lib/ai/provider-meta";

export { PROVIDER_IDS, PROVIDER_LABELS, isProvider, type ProviderId } from "@/lib/ai/provider-meta";
/** USD per 1M tokens, as published by the provider's own model list (only OpenRouter's has them). */
export type ModelPricing = { input: number; output: number };
export type ModelInfo = { id: string; name: string; pricing?: ModelPricing };

export function languageModel(provider: ProviderId, apiKey: string, modelId: string): LanguageModel {
  switch (provider) {
    case "openrouter":
      return createOpenAICompatible({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey })(modelId);
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey })(modelId);
  }
}

/** Thrown for problems the user can act on (bad key, provider down); the message is safe to show. */
export class ProviderError extends Error {}

async function getJson(url: string, headers: Record<string, string>, provider: ProviderId) {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000), cache: "no-store" });
  } catch {
    throw new ProviderError(`Could not reach ${PROVIDER_LABELS[provider]}. Try again in a moment.`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError(`${PROVIDER_LABELS[provider]} rejected this API key.`);
  }
  if (!res.ok) throw new ProviderError(`${PROVIDER_LABELS[provider]} returned an error (${res.status}).`);
  return res.json();
}

type OpenRouterModel = {
  id: string;
  name?: string;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { output_modalities?: string[] };
};

// OpenRouter prices are USD per token as strings; -1 marks dynamic pricing (e.g. the auto router).
function openRouterPricing(m: OpenRouterModel): ModelPricing | undefined {
  const input = Number(m.pricing?.prompt) * 1e6;
  const output = Number(m.pricing?.completion) * 1e6;
  return input >= 0 && output >= 0 ? { input, output } : undefined;
}

// OpenAI's /models also lists embeddings, speech, image and moderation models; keep chat-capable ones.
const OPENAI_CHAT = /^(gpt-|chatgpt-|o\d)/;
const OPENAI_NOT_CHAT = /(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|codex|computer-use)/;

/** Lists the models this key can use. Also doubles as the key check for Anthropic and OpenAI. */
export async function listModels(provider: ProviderId, apiKey: string): Promise<ModelInfo[]> {
  if (provider === "anthropic") {
    const json = await getJson(
      "https://api.anthropic.com/v1/models?limit=1000",
      { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      provider,
    );
    // Anthropic's model list has no prices, and we only show prices a provider itself publishes through its API.
    return (json.data ?? []).map((m: { id: string; display_name?: string }) => ({ id: m.id, name: m.display_name ?? m.id }));
  }

  if (provider === "openai") {
    const json = await getJson("https://api.openai.com/v1/models", { authorization: `Bearer ${apiKey}` }, provider);
    return (json.data ?? [])
      .filter((m: { id: string }) => OPENAI_CHAT.test(m.id) && !OPENAI_NOT_CHAT.test(m.id))
      .sort((a: { created?: number }, b: { created?: number }) => (b.created ?? 0) - (a.created ?? 0))
      .map((m: { id: string }) => ({ id: m.id, name: m.id })); // no prices in OpenAI's list either
  }

  const json = await getJson("https://openrouter.ai/api/v1/models", { authorization: `Bearer ${apiKey}` }, provider);
  return (json.data ?? [])
    .filter((m: OpenRouterModel) => m.architecture?.output_modalities?.includes("text") ?? true)
    .map((m: OpenRouterModel) => ({ id: m.id, name: m.name ?? m.id, pricing: openRouterPricing(m) }))
    .sort((a: ModelInfo, b: ModelInfo) => a.name.localeCompare(b.name));
}

/** OpenRouter's model list is public, so it can't tell us whether a key works; /key can. */
export async function verifyKey(provider: ProviderId, apiKey: string): Promise<void> {
  if (provider === "openrouter") {
    await getJson("https://openrouter.ai/api/v1/key", { authorization: `Bearer ${apiKey}` }, provider);
    return;
  }
  await listModels(provider, apiKey);
}
