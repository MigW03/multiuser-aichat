import { CLAUDE_CODE_LIMITS as CC, type ClaudeCodeErrorCode, type ClaudeCodeEvent, type ClaudeCodeRequest } from "@mc/shared";

// One AI step run with the person's own `claude` program. The chat server owns the AI loop and its tools; this only turns
// one step into one run of `claude` with every built-in tool switched off, and turns what comes back into events:
// text as it is written, and the tools the AI wants to call. A tool call is never run here: `claude` is stopped as soon
// as the AI has said which tools it wants, and the chat server runs them and asks for the next step.

/** The tools of this step as `claude` sees them (they all live under this one server name). */
export const SERVER_NAME = "nido";
const PREFIX = `mcp__${SERVER_NAME}__`;

export class StepError extends Error {
  constructor(
    readonly code: ClaudeCodeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Tool names `claude` accepts, mapped back to the server's own names. */
export function toolNames(tools: ClaudeCodeRequest["tools"]): { exposed: Map<string, string>; list: { name: string; real: string }[] } {
  const exposed = new Map<string, string>();
  const list: { name: string; real: string }[] = [];
  for (const t of tools) {
    let name = t.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "tool";
    for (let i = 2; exposed.has(name); i++) name = `${name.slice(0, 56)}_${i}`;
    exposed.set(name, t.name);
    list.push({ name, real: t.name });
  }
  return { exposed, list };
}

type Block = { kind: "text" } | { kind: "tool"; id: string; name: string; json: string } | { kind: "other" };

/**
 * Reads what `claude` streams (Messages API stream events, wrapped) and says what to tell the chat server.
 * `push` returns events to send; `stop` becomes true once the AI's turn is complete and `claude` can be stopped.
 */
export class StepReader {
  private blocks = new Map<number, Block>();
  private calls = 0;
  private text = false;
  private streamedText = false;
  private input = 0;
  private output = 0;
  private stopReason: string | null = null;
  stop = false;
  finished = false;
  /** An error `claude` reported about the turn itself (not signed in, usage limit, ...). */
  failure: StepError | null = null;

  constructor(private readonly exposed: Map<string, string>) {}

  private end(finish: "stop" | "tool-calls" | "length"): ClaudeCodeEvent[] {
    if (this.finished) return [];
    this.finished = true;
    return [{ kind: "end", finish, usage: { input: this.input, output: this.output } }];
  }

  push(msg: unknown): ClaudeCodeEvent[] {
    if (this.finished || !msg || typeof msg !== "object") return [];
    const m = msg as { type?: unknown };
    if (m.type === "stream_event") return this.stream((msg as { event?: unknown }).event);
    if (m.type === "assistant") {
      const err = (msg as { error?: unknown }).error;
      if (typeof err === "string") {
        this.failure ??= describeAssistantError(err);
        return []; // the text of an error message is claude's, not an answer
      }
      return this.assistantFallback(msg as { message?: { content?: unknown } });
    }
    if (m.type === "result") return this.result(msg as { subtype?: unknown; is_error?: unknown; result?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown }; stop_reason?: unknown });
    return [];
  }

  /** Some versions send whole messages without stream events; text is taken from them only when nothing streamed. */
  private assistantFallback(msg: { message?: { content?: unknown } }): ClaudeCodeEvent[] {
    if (this.streamedText || this.calls > 0) return [];
    const content = msg.message?.content;
    if (!Array.isArray(content)) return [];
    const out: ClaudeCodeEvent[] = [];
    for (const b of content as { type?: unknown; text?: unknown }[]) if (b?.type === "text" && typeof b.text === "string" && b.text) out.push({ kind: "text", text: b.text });
    if (out.length) this.text = true;
    return out;
  }

  private stream(event: unknown): ClaudeCodeEvent[] {
    if (!event || typeof event !== "object") return [];
    const e = event as { type?: unknown; index?: unknown; content_block?: { type?: unknown; id?: unknown; name?: unknown }; delta?: { type?: unknown; text?: unknown; partial_json?: unknown; stop_reason?: unknown }; message?: { usage?: { input_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown } }; usage?: { output_tokens?: unknown } };
    const index = typeof e.index === "number" ? e.index : -1;
    if (e.type === "message_start") {
      const u = e.message?.usage;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      this.input = n(u?.input_tokens) + n(u?.cache_read_input_tokens) + n(u?.cache_creation_input_tokens);
      return [];
    }
    if (e.type === "content_block_start") {
      const b = e.content_block;
      if (b?.type === "text") this.blocks.set(index, { kind: "text" });
      else if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") this.blocks.set(index, { kind: "tool", id: b.id, name: b.name, json: "" });
      else this.blocks.set(index, { kind: "other" }); // thinking: not forwarded
      return [];
    }
    if (e.type === "content_block_delta") {
      const b = this.blocks.get(index);
      if (b?.kind === "text" && e.delta?.type === "text_delta" && typeof e.delta.text === "string" && e.delta.text) {
        this.text = true;
        this.streamedText = true;
        return [{ kind: "text", text: e.delta.text }];
      }
      if (b?.kind === "tool" && e.delta?.type === "input_json_delta" && typeof e.delta.partial_json === "string" && b.json.length < CC.argChars + 10) b.json += e.delta.partial_json;
      return [];
    }
    if (e.type === "content_block_stop") {
      const b = this.blocks.get(index);
      this.blocks.delete(index);
      if (b?.kind !== "tool") return [];
      const real = b.name.startsWith(PREFIX) ? this.exposed.get(b.name.slice(PREFIX.length)) : undefined;
      if (!real) return []; // a tool this step did not offer cannot be called
      if (++this.calls > CC.calls) return [];
      let args = b.json.trim() || "{}";
      try {
        const parsed: unknown = JSON.parse(args);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) args = "{}";
      } catch {
        args = "{}";
      }
      return [{ kind: "call", id: b.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || `call_${this.calls}`, name: real, args }];
    }
    if (e.type === "message_delta") {
      if (typeof e.usage?.output_tokens === "number") this.output = e.usage.output_tokens;
      if (typeof e.delta?.stop_reason === "string") this.stopReason = e.delta.stop_reason;
      return [];
    }
    if (e.type === "message_stop") {
      // The AI's turn is complete. With tool calls, `claude` is stopped before it can do anything about them.
      if (this.calls > 0) {
        this.stop = true;
        return this.end("tool-calls");
      }
      return [];
    }
    return [];
  }

  private result(r: { subtype?: unknown; is_error?: unknown; result?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown }; stop_reason?: unknown }): ClaudeCodeEvent[] {
    const out: ClaudeCodeEvent[] = [];
    if (typeof r.usage?.output_tokens === "number") this.output = r.usage.output_tokens;
    if (typeof r.usage?.input_tokens === "number" && this.input === 0) this.input = r.usage.input_tokens;
    if (r.is_error === true || (typeof r.subtype === "string" && r.subtype.startsWith("error"))) {
      this.failure ??= new StepError("cc_failed", "Claude Code could not answer.");
      return out;
    }
    if (this.failure && this.calls === 0) return out; // an error message that claude wrapped up as a result
    if (!this.text && !this.streamedText && typeof r.result === "string" && r.result) out.push({ kind: "text", text: r.result });
    const stop = typeof r.stop_reason === "string" ? r.stop_reason : this.stopReason;
    return [...out, ...this.end(stop === "max_tokens" ? "length" : "stop")];
  }
}

/** What to tell the person for an error `claude` attached to its turn. Written here; nothing from `claude`'s own text. */
export function describeAssistantError(code: string): StepError {
  switch (code) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
    case "verification_required":
      return new StepError("cc_not_signed_in", "Claude Code is not signed in on this computer. Run `claude auth login` in a terminal, then retry.");
    case "rate_limit":
    case "billing_error":
    case "account_on_hold":
      return new StepError("cc_limit", "Claude Code says this account's usage limit was reached or the account cannot be used right now. Check your plan, then retry.");
    case "model_not_found":
      return new StepError("cc_failed", "Claude Code does not offer this model on this account. Pick another model, then retry.");
    case "overloaded":
      return new StepError("cc_failed", "Claude is overloaded right now. Try again in a moment.");
    default:
      return new StepError("cc_failed", "Claude Code could not answer.");
  }
}

/** What a failed start of `claude` most likely means. `stderr` is read only here and never forwarded. */
export function describeSpawnFailure(err: unknown, stderr: string): StepError {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ENOENT" || code === "EACCES") return new StepError("cc_not_found", "Claude Code was not found on your computer. Check the path in Settings > Claude Code login.");
  if (/not logged in|please run \/login|\/login|invalid api key|oauth token|authentication/i.test(stderr)) return new StepError("cc_not_signed_in", "Claude Code is not signed in on this computer. Run `claude auth login` in a terminal, then retry.");
  return new StepError("cc_failed", "Claude Code stopped before it answered.");
}

/** The slice of the Agent SDK this needs, so a test can stand in for it. */
export type QueryLike = AsyncIterable<unknown> & { close?: () => void; interrupt?: () => Promise<void> };
export type QueryFn = (params: { prompt: string; options: Record<string, unknown> }) => QueryLike;

export type StepDeps = {
  query: QueryFn;
  /** Builds the in-process server that lists this step's tools to `claude`. */
  makeTools: (list: { name: string; description: string; inputSchema: Record<string, unknown> }[]) => unknown;
  bin: string;
  /** An empty folder `claude` runs in. */
  cwd: string;
  env: Record<string, string>;
};

/** Runs one step. Calls `emit` for each event; resolves after the `end` event, or throws a StepError. */
export async function runStep(req: ClaudeCodeRequest, deps: StepDeps, emit: (e: ClaudeCodeEvent) => void, signal: AbortSignal): Promise<void> {
  const { exposed, list } = toolNames(req.tools);
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const reader = new StepReader(exposed);
  let stderr = "";
  const options: Record<string, unknown> = {
    pathToClaudeCodeExecutable: deps.bin,
    cwd: deps.cwd,
    env: deps.env,
    model: req.model,
    systemPrompt: req.system,
    // Nothing of `claude`'s own may run: no file, shell or web tools, no skills, plugins, hooks, memory or settings of the
    // person's own setup, no session saved. The only tools are the step's, and those are never run here (see StepReader).
    tools: [],
    settingSources: [],
    skills: [],
    plugins: [],
    persistSession: false,
    permissionMode: "dontAsk",
    maxTurns: 1,
    strictMcpConfig: true,
    includePartialMessages: true,
    settings: { autoMemoryEnabled: false },
    ...(list.length ? { mcpServers: { [SERVER_NAME]: deps.makeTools(list.map((t, i) => ({ name: t.name, description: req.tools[i]?.description ?? "", inputSchema: req.tools[i]?.inputSchema ?? { type: "object" } }))) } } : {}),
    ...(req.effort === "off" ? { thinking: { type: "disabled" } } : req.effort ? { effort: req.effort } : {}),
    abortController: abort,
    stderr: (d: string) => {
      stderr = (stderr + d).slice(-4000);
    },
  };
  const q = deps.query({ prompt: req.prompt, options });
  let sent = 0;
  try {
    for await (const msg of q) {
      if (signal.aborted) throw new StepError("cc_failed", "Cancelled.");
      for (const ev of reader.push(msg)) {
        if (ev.kind === "text") sent += ev.text.length;
        if (sent > CC.outputChars) throw new StepError("cc_limit", "The answer was too long.");
        emit(ev);
      }
      if (reader.stop || reader.finished) break;
    }
    if (reader.failure && !reader.finished) throw reader.failure;
    if (!reader.finished) {
      if (signal.aborted) throw new StepError("cc_failed", "Cancelled.");
      throw new StepError("cc_failed", "Claude Code stopped before it answered.");
    }
    // `end` was sent. A failure `claude` reported after the AI had already said everything does not undo that.
  } catch (err) {
    if (err instanceof StepError) throw err;
    if (signal.aborted) throw new StepError("cc_failed", "Cancelled.");
    throw reader.failure ?? describeSpawnFailure(err, stderr);
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      abort.abort();
      q.close?.();
    } catch {
      /* already stopped */
    }
  }
}
