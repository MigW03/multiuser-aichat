// Types and constants shared by the server and both clients.

export const PROVIDER_IDS = ["anthropic", "openai", "openrouter", "chatgpt"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  chatgpt: "ChatGPT plan",
};

/** Where a user creates an API key for each provider. ChatGPT plan has no key: the user signs in instead. */
export const PROVIDER_KEY_URLS: Record<ProviderId, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  openrouter: "https://openrouter.ai/keys",
  chatgpt: "https://chatgpt.com/",
};

/** Where a user adds credit (or checks plan usage), for the "out of credit" error. */
export const PROVIDER_BILLING_URLS: Record<ProviderId, string> = {
  anthropic: "https://console.anthropic.com/settings/billing",
  openai: "https://platform.openai.com/settings/organization/billing/overview",
  openrouter: "https://openrouter.ai/settings/credits",
  chatgpt: "https://chatgpt.com/",
};

export function isProvider(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** Providers the user connects by signing in to their own subscription, not by pasting an API key. */
export const isPlanProvider = (provider: ProviderId): boolean => provider === "chatgpt";

// Lowest to highest. Which of these a model offers comes from the provider (see ModelInfo.reasoning).
export const REASONING_LEVELS = ["off", "on", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Reasoning = (typeof REASONING_LEVELS)[number];
export const REASONING_LABELS: Record<Reasoning, string> = { off: "Off", on: "On", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
export function isReasoning(value: unknown): value is Reasoning {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}
/** Shown only until a model's real levels are known, or when the provider does not say. */
export const FALLBACK_REASONING: readonly Reasoning[] = ["off", "low", "medium", "high"];
// "on" stands for a model that can think but has no levels, so it sits where a default level would.
const RANK: Record<Reasoning, number> = { off: 0, minimal: 1, low: 2, on: 3, medium: 3, high: 4, xhigh: 5, max: 6 };
/** The level to use on a model that offers `levels`: the wanted one, else the closest. Null when the model cannot think. */
export function fitReasoning(levels: readonly Reasoning[], wanted: Reasoning): Reasoning | null {
  if (levels.length === 0) return null;
  if (levels.includes(wanted)) return wanted;
  let best = levels[0]!;
  for (const l of levels) if (Math.abs(RANK[l] - RANK[wanted]) < Math.abs(RANK[best] - RANK[wanted])) best = l;
  return best;
}
export const DEFAULT_REASONING: Reasoning = "medium";

/** Limits enforced by both the server and the database. */
export const LIMITS = {
  messageChars: 16_000,
  /** A highlighted excerpt kept with a reply. Small: it lives in the 1 KB meta column. */
  quoteChars: 200,
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
  // a reply to a highlighted part of an answer: the excerpt
  quote?: string;
  // answers: files the AI read from the project's shared folder (paths, as many as fit)
  files?: string[];
  /** The shared folder could not be reached while this answer was written. */
  folder_offline?: boolean;
};

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * True when the words of `quote` appear in `source` in the same order. Loose on purpose: the quote is picked from the
 * rendered answer, so list numbers, link addresses and markdown marks of the raw text may sit between its words.
 */
export function isExcerptOf(quote: string, source: string): boolean {
  const q = words(quote.replace(/…$/, ""));
  if (q.length === 0) return false;
  let i = 0;
  for (const w of words(source)) if (w === q[i] && ++i === q.length) return true;
  return false;
}

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
/** `reasoning` lists the thinking levels the model accepts, lowest first. Empty: it does not think (or cannot be told how). */
export type ModelInfo = { id: string; name: string; pricing?: { input: number; output: number }; reasoning?: Reasoning[] };

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
  /** With replyTo: the part of that answer the reply is about. */
  quote?: string;
};
export type SendMessageResponse = { id: string; skipped: SkipReason | null };
export type SummarizeRequest = { id: string; scope: SummaryScope; provider: ProviderId; model: string; reasoning?: Reasoning };
export type KeyHint = { provider: ProviderId; hint: string };
export type KeysResponse = { keys: KeyHint[] };
export type SaveKeyRequest = { apiKey: string };
export type ModelsResponse = { models: ModelInfo[] };
/** ChatGPT plan sign-in (device flow): the user types `userCode` at `verificationUri`, the client polls with `flow`. */
export type ChatGptStartResponse = { flow: string; userCode: string; verificationUri: string; intervalSeconds: number; expiresInSeconds: number };
/** How much of one rate limit window a ChatGPT plan has used. `resetsAt` is a Unix time in seconds. */
export type UsageWindow = { label: string; usedPercent: number | null; resetsAt: number | null };
export type UsageLimit = { name: string | null; reached: boolean | null; windows: UsageWindow[] };
/** What ChatGPT says about the signed-in plan's limits. `main` is the ordinary limit, `extra` are model or feature specific ones. */
export type ChatGptUsage = { plan: string | null; main: UsageLimit; extra: UsageLimit[]; fetchedAt: number };
export type ChatGptPollResponse ={ status: "pending" } | { status: "connected"; hint: string };
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

// ---- Shared folder: a folder on the project host's computer that project members and the AI can read.
// The host's desktop app serves it through the chat server; the server only relays and checks permissions.

export const FOLDER_LIMITS = {
  nameChars: 80,
  /** Longest path a request may carry, in characters. */
  pathChars: 400,
  /** Entries returned for one directory. */
  listEntries: 500,
  /** Text returned by one read. Longer files are read in parts with an offset. */
  readBytes: 50 * 1024,
  readLines: 2000,
  lineChars: 2000,
  /** Files above this are refused outright. */
  fileBytes: 2 * 1024 * 1024,
  /** Search skips files above this. */
  searchFileBytes: 1024 * 1024,
  searchQueryChars: 100,
  searchMatches: 50,
  searchLineChars: 200,
  searchFiles: 5000,
  searchMs: 8000,
  /** How long the server waits for the host's app to answer one request. */
  requestMs: 20_000,
} as const;

export type FolderEntry = { name: string; type: "file" | "dir"; size?: number };
export type FolderListResult = { path: string; entries: FolderEntry[]; truncated: boolean };
export type FolderReadResult = { path: string; text: string; startLine: number; endLine: number; totalLines: number; truncated: boolean };
export type FolderMatch = { path: string; line: number; text: string };
export type FolderSearchResult = { matches: FolderMatch[]; truncated: boolean };

/** Why the host's app refused a request. The messages are written to be shown. */
export type FolderErrorCode = "invalid_path" | "not_found" | "excluded" | "too_large" | "binary" | "not_a_file" | "not_a_directory" | "bad_request" | "busy" | "failed";

/** What the server asks the host's app to do. `id` pairs the answer with the request. */
export type FolderRequest =
  | { id: string; op: "list"; path: string }
  | { id: string; op: "read"; path: string; offset?: number; limit?: number }
  | { id: string; op: "search"; query: string; path?: string; glob?: string };

export type FolderResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; code: FolderErrorCode; message: string };

/** The one row the server keeps for a project's shared folder: a name and whether the host's app is serving it. Never the path. */
export type ProjectFolder = { project_id: string; name: string; linked_by: string; linked_at: string; online: boolean };

// ---- Realtime broadcast events on the private channel `chat:<id>`

/** Full text so far of an assistant message that is still streaming (sent by the server). */
export type StreamEvent = { messageId: string; content: string };
/** Sent by a client while its user types. Broadcasts aren't signed: treat as a hint only. */
export type TypingEvent = { userId: string };
