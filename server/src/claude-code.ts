import { CLAUDE_CODE_LIMITS as CC, claudeCodeEffort, type ClaudeCodeEvent, type ClaudeCodeRequest } from "@mc/shared";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { ClaudeCodeError } from "./claude-code-error.ts";

export { ClaudeCodeError };

// "Claude Code login" as a language model. The chat server never holds a credential for it: each AI step is handed to the
// asker's own desktop app, which runs the asker's own `claude` program (see desktop/src/claude-code-run.ts). The server
// keeps the AI loop and its tools, so the folder, notes, designs, panels and connected (MCP) tools work as with any provider.

/** What the model needs from the relay: run one step on this person's computer. */
export type ClaudeCodeRunner = {
  ready: (userId: string) => boolean;
  run: (userId: string, req: ClaudeCodeRequest, signal?: AbortSignal) => AsyncGenerator<ClaudeCodeEvent>;
};

let runner: ClaudeCodeRunner | null = null;
/** Called once at start-up with the desktop relay. */
export function registerClaudeCode(r: ClaudeCodeRunner) {
  runner = r;
}
export const claudeCodeReady = (userId: string): boolean => runner?.ready(userId) === true;

// The "key" of this provider is not a secret: it only carries whose desktop app to ask (always the asker's own).
const KEY_PREFIX = "local:claudecode:";
export const claudeCodeKeyFor = (userId: string) => `${KEY_PREFIX}${userId}`;
export function claudeCodeUserOf(key: string): string | null {
  return key.startsWith(KEY_PREFIX) && key.length > KEY_PREFIX.length ? key.slice(KEY_PREFIX.length) : null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[cut: ${s.length - n} more characters]` : s);

function resultText(output: { type: string; value?: unknown }): string {
  const v = output.value;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/**
 * The conversation as plain text for a fresh `claude` run. Pictures and files are left out (this provider is text only).
 * The newest part is kept when it is too long: the beginning of the history is what gets cut.
 */
export function promptFor(prompt: LanguageModelV4Prompt): { system: string; prompt: string } {
  const system: string[] = [];
  const turns: string[] = [];
  for (const m of prompt) {
    if (m.role === "system") {
      system.push(m.content);
    } else if (m.role === "user") {
      const parts = m.content.map((p) => (p.type === "text" ? p.text : `[a ${p.mediaType} file${p.filename ? ` called ${p.filename}` : ""} was attached; this connection cannot read files]`));
      turns.push(`[user]\n${parts.join("\n")}`);
    } else if (m.role === "assistant") {
      const parts: string[] = [];
      for (const p of m.content) {
        if (p.type === "text") parts.push(p.text);
        else if (p.type === "tool-call") parts.push(`[you called the tool ${p.toolName} with ${clip(JSON.stringify(p.input) ?? "{}", 4000)}]`);
      }
      if (parts.length) turns.push(`[assistant]\n${parts.join("\n")}`);
    } else {
      for (const p of m.content) if (p.type === "tool-result") turns.push(`[result of the tool ${p.toolName}]\n${clip(resultText(p.output), 60_000)}`);
    }
  }
  let text = turns.join("\n\n");
  if (text.length > CC.promptChars) text = `[earlier messages cut]\n${text.slice(text.length - CC.promptChars)}`;
  return {
    system: clip(system.join("\n\n"), CC.systemChars),
    prompt: `Below is the conversation so far, oldest first. Write only the next reply as the assistant. Do not repeat the [user], [assistant] or [result of the tool ...] labels.\n\n${text}\n\n[assistant]\n`,
  };
}

const NO_USAGE: LanguageModelV4Usage = { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } };
const usageOf = (u?: { input: number; output: number }): LanguageModelV4Usage =>
  u ? { inputTokens: { total: u.input, noCache: u.input, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: u.output, text: u.output, reasoning: undefined } } : NO_USAGE;

function requestFor(modelId: string, options: LanguageModelV4CallOptions): ClaudeCodeRequest {
  const { system, prompt } = promptFor(options.prompt);
  const tools = (options.tools ?? [])
    .flatMap((t) => (t.type === "function" ? [t] : []))
    .slice(0, CC.tools)
    .map((t) => ({
      name: t.name.slice(0, CC.toolNameChars),
      description: (t.description ?? "").slice(0, CC.descriptionChars),
      inputSchema: JSON.stringify(t.inputSchema).length <= CC.schemaChars ? (t.inputSchema as Record<string, unknown>) : { type: "object", additionalProperties: true },
    }));
  return { model: modelId, system, prompt, effort: claudeCodeEffort(options.reasoning), tools };
}

/** A language model that runs on `userId`'s own computer with their own Claude Code login. */
export function claudeCodeModel(userId: string, modelId: string): LanguageModelV4 {
  const stream = (options: LanguageModelV4CallOptions): ReadableStream<LanguageModelV4StreamPart> => {
    const r = runner;
    const req = requestFor(modelId, options);
    return new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        if (!r) {
          controller.enqueue({ type: "error", error: new ClaudeCodeError("cc_unavailable", "Claude Code login is not available on this server.") });
          controller.close();
          return;
        }
        let open = false;
        try {
          for await (const ev of r.run(userId, req, options.abortSignal)) {
            if (ev.kind === "text") {
              if (!open) controller.enqueue({ type: "text-start", id: "t" });
              open = true;
              controller.enqueue({ type: "text-delta", id: "t", delta: ev.text });
            } else if (ev.kind === "call") {
              if (open) controller.enqueue({ type: "text-end", id: "t" });
              open = false;
              controller.enqueue({ type: "tool-call", toolCallId: ev.id, toolName: ev.name, input: ev.args });
            } else {
              if (open) controller.enqueue({ type: "text-end", id: "t" });
              open = false;
              controller.enqueue({ type: "finish", usage: usageOf(ev.usage), finishReason: { unified: ev.finish === "tool-calls" ? "tool-calls" : ev.finish === "length" ? "length" : "stop", raw: ev.finish } });
            }
          }
        } catch (error) {
          if (open) controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({ type: "error", error });
        }
        controller.close();
      },
    });
  };

  return {
    specificationVersion: "v4",
    provider: "claudecode",
    modelId,
    supportedUrls: {},
    async doStream(options) {
      return { stream: stream(options) };
    },
    async doGenerate(options) {
      const content: Awaited<ReturnType<LanguageModelV4["doGenerate"]>>["content"] = [];
      let text = "";
      let finishReason: Awaited<ReturnType<LanguageModelV4["doGenerate"]>>["finishReason"] = { unified: "stop", raw: undefined };
      let usage = NO_USAGE;
      const reader = stream(options).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === "error") throw value.error;
        if (value.type === "text-delta") text += value.delta;
        else if (value.type === "tool-call") content.push(value);
        else if (value.type === "finish") {
          finishReason = value.finishReason;
          usage = value.usage;
        }
      }
      if (text) content.unshift({ type: "text", text });
      return { content, finishReason, usage, warnings: [] };
    },
  };
}
