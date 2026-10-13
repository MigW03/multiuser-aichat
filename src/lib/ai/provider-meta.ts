// Client-safe provider info. Anything that needs the AI SDK lives in providers.ts (server only).

export const PROVIDER_IDS = ["openrouter", "anthropic", "openai"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/** Where a user creates an API key for each provider. */
export const PROVIDER_KEY_URLS: Record<ProviderId, string> = {
  openrouter: "https://openrouter.ai/keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
};

export function isProvider(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}
