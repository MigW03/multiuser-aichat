import type { ModelInfo, Reasoning } from "./index.ts";

// "Claude Code login": an AI provider that lets one person use their own Claude subscription (the one they signed in
// to with the real `claude` program on their computer). It exists only in the desktop app. The chat server never sees a
// credential: for each AI step it sends the conversation down that person's own desktop connection, the app runs the
// person's own unmodified `claude` program on that computer, and the answer comes back the same way.
// Only the asker's own computer is ever used, and only for answers the asker asked for.

export const CLAUDE_CODE_LIMITS = {
  /** The conversation as text, one step. */
  promptChars: 1_500_000,
  /** The system instructions of one step. */
  systemChars: 200_000,
  /** Tools the AI may call in one step. */
  tools: 200,
  /** One tool's name, description and JSON schema. */
  toolNameChars: 128,
  descriptionChars: 2000,
  schemaChars: 30_000,
  /** What one step may write back. */
  outputChars: 400_000,
  /** Tool calls in one step, and the arguments of one call. */
  calls: 32,
  argChars: 200_000,
  /** A step that says nothing at all for this long has stalled. */
  idleMs: 180_000,
  /** The longest one step may run. */
  totalMs: 15 * 60_000,
} as const;

/** How hard the AI thinks, as `claude` names it. "off" turns thinking off. */
export type ClaudeCodeEffort = "off" | "low" | "medium" | "high" | "xhigh" | "max";
export const CLAUDE_CODE_EFFORTS: readonly ClaudeCodeEffort[] = ["off", "low", "medium", "high", "xhigh", "max"];

/** The models `claude` takes by short name. Each name always means the newest model of that kind on the person's plan. */
export const CLAUDE_CODE_MODELS: ModelInfo[] = [
  { id: "sonnet", name: "Claude Sonnet (latest)", reasoning: ["off", "low", "medium", "high"], vision: false, tools: true },
  { id: "opus", name: "Claude Opus (latest)", reasoning: ["off", "low", "medium", "high", "xhigh", "max"], vision: false, tools: true },
  { id: "haiku", name: "Claude Haiku (latest)", reasoning: ["off"], vision: false, tools: true },
];

export const isClaudeCodeModel = (id: unknown): id is string => typeof id === "string" && CLAUDE_CODE_MODELS.some((m) => m.id === id);

/** Maps the app's thinking level to `claude`'s. "provider-default" and anything unknown means the model's own default (null). */
export function claudeCodeEffort(level: Reasoning | "provider-default" | "none" | undefined | null): ClaudeCodeEffort | null {
  if (!level || level === "provider-default") return null;
  if (level === "off" || level === "none") return "off";
  if (level === "on" || level === "minimal") return "low";
  return (CLAUDE_CODE_EFFORTS as readonly string[]).includes(level) ? (level as ClaudeCodeEffort) : null;
}

export type ClaudeCodeTool = { name: string; description: string; inputSchema: Record<string, unknown> };

/** One AI step, as the chat server asks the person's desktop app to run it. */
export type ClaudeCodeRequest = {
  model: string;
  /** The instructions for the AI. */
  system: string;
  /** The conversation so far, as text, ending with what the AI has to answer. */
  prompt: string;
  effort: ClaudeCodeEffort | null;
  /** What the AI may call. Calls are handed back, never run by `claude`: the chat server runs them. */
  tools: ClaudeCodeTool[];
};

/** What the desktop app sends back while a step runs. */
export type ClaudeCodeEvent =
  | { kind: "text"; text: string }
  | { kind: "call"; id: string; name: string; args: string }
  | { kind: "end"; finish: "stop" | "tool-calls" | "length"; usage?: { input: number; output: number } };

export type ClaudeCodeErrorCode = "cc_unavailable" | "cc_not_found" | "cc_not_signed_in" | "cc_limit" | "cc_failed" | "busy" | "bad_request";

/** What the app tells the server about itself: whether the AI may use this person's Claude Code login right now. */
export type ClaudeCodeReport = { ready: boolean };

/** What the desktop app tells the page. */
export type ClaudeCodeStatus = {
  /** The person turned it on in this app (off by default). */
  enabled: boolean;
  /** Where `claude` was found, shortened for display (home folder as ~). null: not found. */
  binary: string | null;
  /** The person chose this program themselves instead of the one found on the usual paths. */
  custom: boolean;
  /** What `claude` itself says about the sign-in. "unknown" until it was asked. */
  login: "signed_in" | "signed_out" | "unknown";
  /** The account line `claude auth status` printed, for the person to recognise. Never a token. */
  account: string | null;
  /** A short problem to show, if any. */
  error: string | null;
  /** The connection to the chat server (the AI can use the login only while connected). */
  link: "off" | "connecting" | "connected" | "auth";
};
