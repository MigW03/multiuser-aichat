// Types and constants shared by the server and both clients.

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

/** Limits enforced by both the server and the database. */
export const LIMITS = {
  messageChars: 16_000,
  titleChars: 80,
  modelIdPattern: /^[A-Za-z0-9._:/@-]{1,200}$/,
} as const;

export type MessageStatus = "pending" | "processing" | "streaming" | "done" | "error";

export type ChatMessage = {
  id: string;
  chat_id: string;
  author_id: string | null;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  seq: number;
  provider: ProviderId | null;
  model: string | null;
};

export type Chat = { id: string; title: string; created_at: string };
export type Member = { id: string; display_name: string };
export type ModelChoice = { provider: ProviderId; model: string };
export type ModelInfo = { id: string; name: string; pricing?: { input: number; output: number } };

// ---- Server HTTP API (all routes need `Authorization: Bearer <supabase access token>`)

export type SendMessageRequest = { id: string; content: string; provider: ProviderId; model: string };
export type SendMessageResponse = { id: string };
export type KeyHint = { provider: ProviderId; hint: string };
export type KeysResponse = { keys: KeyHint[] };
export type SaveKeyRequest = { apiKey: string };
export type ModelsResponse = { models: ModelInfo[] };
export type ApiError = { error: string };

// ---- Realtime broadcast events on the private channel `chat:<id>`

/** Full text so far of an assistant message that is still streaming (sent by the server). */
export type StreamEvent = { messageId: string; content: string };
