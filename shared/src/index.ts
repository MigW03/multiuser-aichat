// Types and constants shared by the server and both clients.

export const PROVIDER_IDS = ["anthropic", "openai", "openrouter"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

/** Where a user creates an API key for each provider. */
export const PROVIDER_KEY_URLS: Record<ProviderId, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  openrouter: "https://openrouter.ai/keys",
};

/** Where a user adds credit, for the "out of credit" error. */
export const PROVIDER_BILLING_URLS: Record<ProviderId, string> = {
  anthropic: "https://console.anthropic.com/settings/billing",
  openai: "https://platform.openai.com/settings/organization/billing/overview",
  openrouter: "https://openrouter.ai/settings/credits",
};

export function isProvider(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

export const REASONING_LEVELS = ["off", "low", "medium", "high"] as const;
export type Reasoning = (typeof REASONING_LEVELS)[number];
export const REASONING_LABELS: Record<Reasoning, string> = { off: "Off", low: "Low", medium: "Medium", high: "High" };
export function isReasoning(value: unknown): value is Reasoning {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}
export const DEFAULT_REASONING: Reasoning = "medium";

/** Limits enforced by both the server and the database. */
export const LIMITS = {
  messageChars: 16_000,
  titleChars: 80,
  projectNameChars: 60,
  displayNameChars: 60,
  /** People in one project (or one shared chat). Pending invites count toward it. */
  maxPeople: 10,
  inviteDays: 7,
  passwordMin: 8,
  modelIdPattern: /^[A-Za-z0-9._:/@-]{1,200}$/,
} as const;

export type Role = "host" | "admin" | "member";
export const ROLE_LABELS: Record<Role, string> = { host: "Host", admin: "Admin", member: "Member" };
/** Roles an invite or a role change can assign. The host is whoever created the project. */
export const ASSIGNABLE_ROLES = ["admin", "member"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
export const canManagePeople = (role: Role | null | undefined) => role === "host" || role === "admin";

export type MessageStatus = "pending" | "processing" | "streaming" | "done" | "error";
export type MessageKind = "message" | "summary_request" | "summary";
export type SkipReason = "mention" | "no_key";
export type SummaryScope = "unread" | "day" | "all";

/** Why an AI answer failed, so the chat can offer the right next step. */
export type AiErrorCode = "invalid_key" | "no_credit" | "rate_limit" | "timeout" | "no_key" | "model" | "stopped" | "other";

export type MessageMeta = {
  // summary_request: what to summarize. summary (answer): what it covered.
  scope?: SummaryScope;
  from_seq?: number;
  count?: number;
  since?: string;
  // error answers
  error?: AiErrorCode;
};

export type ChatMessage = {
  id: string;
  chat_id: string;
  author_id: string | null;
  role: "user" | "assistant";
  kind: MessageKind;
  content: string;
  status: MessageStatus;
  seq: number;
  created_at: string;
  provider: ProviderId | null;
  model: string | null;
  reasoning: Reasoning | null;
  reply_to: string | null;
  mentions: string[];
  skip_reason: SkipReason | null;
  for_user_id: string | null;
  key_user_id: string | null;
  run_id: string | null;
  meta: MessageMeta;
};

/** Columns the clients select. Keep in step with ChatMessage. */
export const MESSAGE_COLUMNS =
  "id, chat_id, author_id, role, kind, content, status, seq, created_at, provider, model, reasoning, reply_to, mentions, skip_reason, for_user_id, key_user_id, run_id, meta";

export type ChatSummary = {
  id: string;
  title: string;
  project_id: string | null;
  created_by: string;
  created_at: string;
  last_message_at: string;
  preview: string | null;
  preview_role: "user" | "assistant" | null;
  preview_author: string | null;
  /** Rows in chat_members: 1 for a private home chat, more once someone was invited. Always 0 for project chats. */
  member_count: number;
  pinned: boolean;
  unread_people: number;
  unread_ai: number;
};

export type ProjectSummary = {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  my_role: Role;
  member_count: number;
  unread_people: number;
  unread_ai: number;
};

export type Person = { id: string; display_name: string };
export type ProjectMember = Person & { email: string; role: Role; joined_at: string };
export type ModelChoice = { provider: ProviderId; model: string; reasoning: Reasoning };
export type ModelInfo = { id: string; name: string; pricing?: { input: number; output: number } };

/** Short label for a model id: "claude-sonnet-4-5-20250929" -> "Sonnet 4.5". Falls back to the id. */
export function modelLabel(model: string | null | undefined): string {
  if (!model) return "AI";
  const id = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const claude = id.match(/^claude-(?:(opus|sonnet|haiku|fable)-)?(\d+(?:[.-]\d+)?)?(?:-(opus|sonnet|haiku|fable))?/i);
  if (claude && (claude[1] || claude[3])) {
    const family = (claude[1] ?? claude[3])!;
    const version = claude[2]?.replace("-", ".");
    return `${family[0]!.toUpperCase()}${family.slice(1)}${version ? ` ${version}` : ""}`;
  }
  return id.length > 24 ? `${id.slice(0, 23)}…` : id;
}

/** What the AI is called in the chat: "Claude Sonnet 4.5" for Anthropic models, the short id for the rest, "AI" when unknown. */
export function modelName(model: string | null | undefined): string {
  const short = modelLabel(model);
  return model && /claude/i.test(model) && !/^claude/i.test(short) ? `Claude ${short}` : short;
}

// ---- Server HTTP API (all routes need `Authorization: Bearer <supabase access token>` unless noted)

export type SendMessageRequest = {
  id: string;
  content: string;
  provider?: ProviderId;
  model?: string;
  reasoning?: Reasoning;
  /** People tagged with @. A message that tags someone is not answered by the AI. */
  mentions?: string[];
  replyTo?: string;
};
export type SendMessageResponse = { id: string; skipped: SkipReason | null };
export type SummarizeRequest = { id: string; scope: SummaryScope; provider: ProviderId; model: string; reasoning?: Reasoning };
export type KeyHint = { provider: ProviderId; hint: string };
export type KeysResponse = { keys: KeyHint[] };
export type SaveKeyRequest = { apiKey: string };
export type ModelsResponse = { models: ModelInfo[] };
export type ApiError = { error: string };

export type InviteScope = "project" | "chat";
export type PendingInvite = { id: string; email: string; role: AssignableRole; token: string; created_at: string; expires_at: string };
export type InviteStatus = "valid" | "expired" | "used" | "full" | "invalid";
export type InvitePreview = {
  status: InviteStatus;
  scope: InviteScope | null;
  name: string | null;
  inviter: string | null;
  role: AssignableRole | null;
  /** Full address when the caller is signed out or is that account; otherwise a masked hint like "d•••@example.com". */
  email: string | null;
  emailMasked: boolean;
  members: { name: string; role: Role }[];
};
export type AcceptInviteResponse = { projectId: string | null; chatId: string | null };

// ---- Realtime broadcast events on the private channel `chat:<id>`

/** Full text so far of an assistant message that is still streaming (sent by the server). */
export type StreamEvent = { messageId: string; content: string };
/** Sent by a client while its user types. Broadcasts aren't signed: treat as a hint only. */
export type TypingEvent = { userId: string };
