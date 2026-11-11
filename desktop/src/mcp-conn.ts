import type { ClaudeCodeEvent, ClaudeCodeReport, FolderResponse, McpState } from "@mc/shared";

// This person's connection to the chat server for connected tools (MCP): one outgoing WebSocket for the signed-in
// user, not one per project. The server sends a tool call down it only for an AI answer this person asked for; the app
// reports which tools exist (`mcp` message) and answers the calls. Nothing is listening on this computer.

export type McpLink = "off" | "connecting" | "connected" | "auth";

type Options = {
  wsUrl: string;
  getToken: () => string;
  getState: () => McpState;
  /** A tool call. Aborting stops waiting for it (the server withdrew it, or the connection ended). */
  call: (req: unknown, signal: AbortSignal) => Promise<FolderResponse | null>;
  /** One AI step on this person's own Claude Code login: events go to `emit`; a thrown error carries a code and a message written to be shown. */
  llm?: (req: unknown, signal: AbortSignal, emit: (e: ClaudeCodeEvent) => void) => Promise<void>;
  /** Whether the AI may use this person's Claude Code login now. */
  getClaudeCode?: () => ClaudeCodeReport;
  onLink: (link: McpLink) => void;
};

/** Largest frame from the server: a call's arguments (checked again per field by the host). */
const MAX_FRAME_CHARS = 300_000;
/** The server pings every 20 s. Silence for longer than this means the connection is dead. */
const SILENCE_MS = 70_000;
/** Tool calls in flight at once; the host's switches check again, this keeps a flood off the servers. */
const MAX_CALLS = 4;
/** AI steps in flight at once (the host checks again). */
const MAX_LLM = 3;
/** Text is sent in bursts this far apart, not one frame per word. */
const TEXT_EVERY_MS = 40;

export class McpConn {
  link: McpLink = "connecting";
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private closed = false;
  private readonly calls = new Map<string, AbortController>();
  private readonly llmRuns = new Map<string, AbortController>();

  constructor(private readonly o: Options) {
    this.open();
  }

  private set(link: McpLink) {
    if (this.link === link) return;
    this.link = link;
    this.o.onLink(link);
  }

  private open() {
    if (this.closed) return;
    this.set("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.o.wsUrl);
    } catch {
      this.retryLater();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.arm();
      ws.send(JSON.stringify({ type: "hello", token: this.o.getToken() }));
    };
    ws.onmessage = (event) => {
      this.arm();
      if (typeof event.data !== "string" || event.data.length > MAX_FRAME_CHARS) return;
      let msg: { type?: unknown; code?: unknown } & Record<string, unknown>;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "ready") {
        this.attempt = 0;
        this.set("connected");
        this.stateChanged();
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      } else if (msg.type === "error") {
        // unauthorized: wait for a fresh token (tokenChanged).
        this.set("auth");
      } else if (msg.type === "req" && this.link === "connected") {
        this.run(msg.req);
      } else if (msg.type === "cancel" && typeof msg.id === "string" && msg.id.length <= 64) {
        this.calls.get(msg.id)?.abort();
        this.llmRuns.get(msg.id)?.abort();
      }
    };
    ws.onclose = () => {
      clearTimeout(this.watchdog);
      this.ws = null;
      for (const c of this.calls.values()) c.abort();
      for (const c of this.llmRuns.values()) c.abort();
      if (this.closed) return;
      if (this.link === "auth") return; // waits for a fresh token
      this.set("connecting");
      this.retryLater();
    };
    ws.onerror = () => undefined; // onclose follows
  }

  private arm() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.ws?.close(), SILENCE_MS);
  }

  private retryLater() {
    if (this.closed) return;
    clearTimeout(this.timer);
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5)) + Math.random() * 500;
    this.timer = setTimeout(() => this.open(), wait);
  }

  /** A fresh access token: tell the server on a live connection, or try again when it was waiting for one. */
  tokenChanged() {
    if (this.link === "auth") {
      this.set("connecting");
      this.open();
    } else if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "token", token: this.o.getToken() }));
    }
  }

  /** Tells the server which tools the AI may use for this person, and that this app keeps custom panels. */
  stateChanged() {
    if (this.ws?.readyState === WebSocket.OPEN && this.link === "connected") this.ws.send(JSON.stringify({ type: "mcp", panels: true, ...(this.o.getClaudeCode ? { claudeCode: this.o.getClaudeCode() } : {}), mcp: this.o.getState() }));
  }

  private run(req: unknown) {
    const id = (req as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 64) return;
    if ((req as { op?: unknown }).op === "llm") return this.runLlm(id, req);
    if (this.calls.size >= MAX_CALLS) return this.send({ id, ok: false, code: "busy", message: "Several tool calls are already running. Try again in a moment." });
    const controller = new AbortController();
    this.calls.set(id, controller);
    void this.o
      .call(req, controller.signal)
      .then((res) => res && !controller.signal.aborted && this.send(res))
      .catch((e) => {
        console.error("[mcp] call failed:", e instanceof Error ? e.message : e);
        this.send({ id, ok: false, code: "mcp_failed", message: "The tool server failed to run that tool." });
      })
      .finally(() => this.calls.delete(id));
  }

  private runLlm(id: string, req: unknown) {
    const fail = (code: string, message: string) => this.sendFrame({ type: "llm_err", id, code, message });
    if (!this.o.llm) return fail("cc_unavailable", "This app cannot run Claude Code login.");
    if (this.llmRuns.size >= MAX_LLM) return fail("busy", "Several answers are already running on your Claude Code login. Try again in a moment.");
    const controller = new AbortController();
    this.llmRuns.set(id, controller);
    let pending = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (pending && !controller.signal.aborted) this.sendFrame({ type: "llm", id, event: { kind: "text", text: pending } });
      pending = "";
    };
    const emit = (event: ClaudeCodeEvent) => {
      if (controller.signal.aborted) return;
      if (event.kind === "text") {
        pending += event.text;
        timer ??= setTimeout(flush, TEXT_EVERY_MS);
        return;
      }
      flush();
      this.sendFrame({ type: "llm", id, event });
    };
    void this.o
      .llm(req, controller.signal, emit)
      .catch((e: unknown) => {
        flush();
        const code = (e as { code?: unknown } | null)?.code;
        const known = ["cc_unavailable", "cc_not_found", "cc_not_signed_in", "cc_limit", "cc_failed", "busy", "bad_request"];
        if (e instanceof Error && typeof code === "string" && known.includes(code)) return fail(code, e.message);
        console.error("[claudecode] step failed:", e instanceof Error ? e.message : "unknown error");
        fail("cc_failed", "Claude Code stopped before it answered.");
      })
      .finally(() => {
        flush();
        this.llmRuns.delete(id);
      });
  }

  private sendFrame(frame: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private send(res: FolderResponse) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "res", res }));
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.watchdog);
    for (const c of this.calls.values()) c.abort();
    for (const c of this.llmRuns.values()) c.abort();
    this.ws?.close();
    this.ws = null;
  }
}
