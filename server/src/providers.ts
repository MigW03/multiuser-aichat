import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { isReasoning, PROVIDER_LABELS, REASONING_LEVELS, type ModelInfo, type ProviderId, type Reasoning } from "@mc/shared";
import type { LanguageModel } from "ai";
import { chatgptModel, listChatGptModels } from "./chatgpt.ts";
import { ProviderError } from "./provider-error.ts";

export { ProviderError };

/** `apiKey` is the credential from getUserKey: an API key, or for ChatGPT plan the current access token. */
export function languageModel(provider: ProviderId, apiKey: string, modelId: string): LanguageModel {
  switch (provider) {
    case "chatgpt":
      return chatgptModel(apiKey, modelId);
    case "openrouter":
      return createOpenAICompatible({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey })(modelId);
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey })(modelId);
  }
}

/** The thinking part of a streamText call. OpenRouter models differ too much for one effort name, so its own `reasoning` object is sent. */
export function reasoningOptions(provider: ProviderId, level: Reasoning | null) {
  if (!level) return {};
  if (provider === "openrouter") {
    const reasoning = level === "off" ? { effort: "none" } : level === "on" ? { enabled: true } : { effort: level };
    return { providerOptions: { openrouter: { reasoning } } };
  }
  return { reasoning: level === "off" ? ("none" as const) : level === "on" ? ("medium" as const) : level };
}

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

type OpenRouterModel = {
  id: string;
  name?: string;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { output_modalities?: string[]; input_modalities?: string[] };
  supported_parameters?: string[];
  reasoning?: { supported_efforts?: string[]; mandatory?: boolean };
};

const inOrder = (levels: Iterable<Reasoning>): Reasoning[] => REASONING_LEVELS.filter((l) => new Set(levels).has(l));

/** OpenRouter lists, per model, the efforts it accepts and whether thinking can be switched off. */
export function openRouterLevels(m: Pick<OpenRouterModel, "supported_parameters" | "reasoning">): Reasoning[] | undefined {
  const r = m.reasoning;
  if (!r) {
    if (!Array.isArray(m.supported_parameters)) return undefined;
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    return params.includes("reasoning") || params.includes("include_reasoning") ? ["off", "on"] : [];
  }
  const efforts = (Array.isArray(r.supported_efforts) ? r.supported_efforts : []).map((e) => (e === "none" ? "off" : e)).filter(isReasoning);
  if (efforts.length === 0) return r.mandatory ? [] : ["off", "on"]; // thinks, but there is no dial
  return inOrder(r.mandatory ? efforts : [...efforts, "off"]);
}

type AnthropicCapability = { supported?: boolean };
type AnthropicModel = {
  id: string;
  display_name?: string;
  capabilities?: {
    thinking?: { supported?: boolean; types?: { disabled?: AnthropicCapability } };
    effort?: { supported?: boolean } & Record<string, unknown>;
    image_input?: AnthropicCapability;
  } | null;
};

/** Anthropic reports thinking and effort support per model. Models that think on a token budget get low/medium/high. */
export function anthropicLevels(caps: AnthropicModel["capabilities"]): Reasoning[] | undefined {
  if (!caps?.thinking) return undefined;
  if (!caps.thinking.supported) return [];
  const levels = new Set<Reasoning>();
  if (caps.thinking.types?.disabled?.supported !== false) levels.add("off");
  if (caps.effort?.supported) {
    for (const l of ["low", "medium", "high", "xhigh", "max"] as const) {
      if ((caps.effort[l] as AnthropicCapability | undefined)?.supported) levels.add(l);
    }
  } else {
    for (const l of ["low", "medium", "high"] as const) levels.add(l);
  }
  return inOrder(levels);
}

/** OpenAI says nothing about thinking in /models, so this follows the model families (and the SDK's own table). */
export function openaiLevels(id: string): Reasoning[] {
  if (/^o\d+(-|$)/.test(id)) return ["low", "medium", "high"];
  const gpt = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(id);
  if (!gpt) return [];
  const major = Number(gpt[1]);
  const minor = gpt[2] == null ? null : Number(gpt[2]);
  const variant = gpt[3] ?? "";
  if (major < 5 || (minor == null && variant.startsWith("chat"))) return [];
  if (major >= 6) return id === "gpt-6-sol" || id === "gpt-6-luna" ? ["off", "low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high", "xhigh", "max"];
  if (variant.startsWith("pro")) return ["high"];
  if (minor == null) return ["minimal", "low", "medium", "high"];
  return ["off", "low", "medium", "high"];
}

/** Anthropic says per model whether it takes pictures; no answer means unknown. */
export function anthropicVision(caps: AnthropicModel["capabilities"]): boolean | undefined {
  const supported = caps?.image_input?.supported;
  return typeof supported === "boolean" ? supported : undefined;
}

/** OpenAI's /models does not say, so this follows the model families that take pictures (GPT-4o and newer, o-series from o1). */
export function openaiVision(id: string): boolean {
  return /^(gpt-4o|chatgpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-[5-9]|o1($|-20|-pro)|o3($|-20|-pro)|o4)/.test(id);
}

// OpenAI's /models also lists embedding, audio, image and moderation models; keep the chat ones.
const OPENAI_CHAT = /^(gpt-|chatgpt-|o\d)/;
const OPENAI_NOT_CHAT = /(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|codex|computer-use)/;

/** The models this key can use. Also works as the key check for Anthropic and OpenAI. */
export async function listModels(provider: ProviderId, apiKey: string): Promise<ModelInfo[]> {
  if (provider === "chatgpt") return listChatGptModels(apiKey);
  if (provider === "anthropic") {
    const json = await getJson("https://api.anthropic.com/v1/models?limit=1000", { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, provider);
    return ((json.data ?? []) as AnthropicModel[]).map((m) => ({ id: m.id, name: m.display_name ?? m.id, reasoning: anthropicLevels(m.capabilities), vision: anthropicVision(m.capabilities) }));
  }
  if (provider === "openai") {
    const json = await getJson("https://api.openai.com/v1/models", { authorization: `Bearer ${apiKey}` }, provider);
    return ((json.data ?? []) as { id: string; created?: number }[])
      .filter((m) => OPENAI_CHAT.test(m.id) && !OPENAI_NOT_CHAT.test(m.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map((m) => ({ id: m.id, name: m.id, reasoning: openaiLevels(m.id), vision: openaiVision(m.id) }));
  }
  const json = await getJson("https://openrouter.ai/api/v1/models", { authorization: `Bearer ${apiKey}` }, provider);
  return ((json.data ?? []) as OpenRouterModel[])
    .filter((m) => m.architecture?.output_modalities?.includes("text") ?? true)
    .map((m) => {
      // OpenRouter prices are USD per token as strings; negative means dynamic pricing.
      const input = Number(m.pricing?.prompt) * 1e6;
      const output = Number(m.pricing?.completion) * 1e6;
      return { id: m.id, name: m.name ?? m.id, pricing: input >= 0 && output >= 0 ? { input, output } : undefined, reasoning: openRouterLevels(m), vision: m.architecture?.input_modalities ? m.architecture.input_modalities.includes("image") : undefined, tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes("tools") : undefined };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** OpenRouter's model list is public, so it can't tell whether a key works; /key can. */
export async function verifyKey(provider: ProviderId, apiKey: string): Promise<void> {
  if (provider === "chatgpt") throw new ProviderError("ChatGPT plan is connected by signing in, not with a key.");
  if (provider === "openrouter") {
    await getJson("https://openrouter.ai/api/v1/key", { authorization: `Bearer ${apiKey}` }, provider);
    return;
  }
  await listModels(provider, apiKey);
}
