import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { PROVIDER_LABELS, type ModelInfo, type ProviderId } from "@mc/shared";
import type { LanguageModel } from "ai";

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

/** A problem the user can act on (bad key, provider down). The message is safe to show. */
export class ProviderError extends Error {}

async function getJson(url: string, headers: Record<string, string>, provider: ProviderId) {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new ProviderError(`Could not reach ${PROVIDER_LABELS[provider]}. Try again in a moment.`);
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError(`${PROVIDER_LABELS[provider]} rejected this API key.`);
  if (!res.ok) throw new ProviderError(`${PROVIDER_LABELS[provider]} returned an error (${res.status}).`);
  return res.json() as Promise<{ data?: unknown[] }>;
}

type OpenRouterModel = { id: string; name?: string; pricing?: { prompt?: string; completion?: string }; architecture?: { output_modalities?: string[] } };

// OpenAI's /models also lists embedding, audio, image and moderation models; keep the chat ones.
const OPENAI_CHAT = /^(gpt-|chatgpt-|o\d)/;
const OPENAI_NOT_CHAT = /(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|codex|computer-use)/;

/** The models this key can use. Also works as the key check for Anthropic and OpenAI. */
export async function listModels(provider: ProviderId, apiKey: string): Promise<ModelInfo[]> {
  if (provider === "anthropic") {
    const json = await getJson("https://api.anthropic.com/v1/models?limit=1000", { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, provider);
    return ((json.data ?? []) as { id: string; display_name?: string }[]).map((m) => ({ id: m.id, name: m.display_name ?? m.id }));
  }
  if (provider === "openai") {
    const json = await getJson("https://api.openai.com/v1/models", { authorization: `Bearer ${apiKey}` }, provider);
    return ((json.data ?? []) as { id: string; created?: number }[])
      .filter((m) => OPENAI_CHAT.test(m.id) && !OPENAI_NOT_CHAT.test(m.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map((m) => ({ id: m.id, name: m.id }));
  }
  const json = await getJson("https://openrouter.ai/api/v1/models", { authorization: `Bearer ${apiKey}` }, provider);
  return ((json.data ?? []) as OpenRouterModel[])
    .filter((m) => m.architecture?.output_modalities?.includes("text") ?? true)
    .map((m) => {
      // OpenRouter prices are USD per token as strings; negative means dynamic pricing.
      const input = Number(m.pricing?.prompt) * 1e6;
      const output = Number(m.pricing?.completion) * 1e6;
      return { id: m.id, name: m.name ?? m.id, pricing: input >= 0 && output >= 0 ? { input, output } : undefined };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** OpenRouter's model list is public, so it can't tell whether a key works; /key can. */
export async function verifyKey(provider: ProviderId, apiKey: string): Promise<void> {
  if (provider === "openrouter") {
    await getJson("https://openrouter.ai/api/v1/key", { authorization: `Bearer ${apiKey}` }, provider);
    return;
  }
  await listModels(provider, apiKey);
}
