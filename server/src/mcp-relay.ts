import { CLAUDE_CODE_LIMITS as CC, MCP_LIMITS as ML, type ClaudeCodeEvent, type ClaudeCodeRequest, type FolderErrorCode, type McpCallResult, type McpState, type PanelDraft } from "@mc/shared";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { ClaudeCodeError } from "./claude-code-error.ts";
import { RelayError } from "./folder-relay.ts";

// The relay for connected tools (MCP). Tool servers belong to a person and run on that person's computer, so each signed-in
// desktop app keeps ONE WebSocket here (not one per project). When that person asks the AI something, the run asks this
// relay for their tools and, if the AI uses one, sends the call down that person's socket. The relay never lets one
// person's socket answer for another: a run only ever asks for its asker's user id.
//
// The desktop app is not trusted with more than answering: its tool list and every answer are validated and size-limited
// here before they reach the AI.

export type McpRelayDeps = {
  /** The user id for a Supabase access token, or null. */
  authenticate: (token: string) => Promise<string | null>;
};

export type McpRequest = { server: string; tool: string; args: Record<string, unknown> };

/** What the AI may ask the person's own desktop app about their custom panels (never anyone else's). The app answers in JSON text. */
export type PanelRequest =
  | { panelOp: "list"; projectId: string }
  | { panelOp: "draft"; projectId: string; chatId?: string; panelId?: string; draft: PanelDraft }
  | { panelOp: "delete_request"; projectId: string; chatId?: string; panelId: string };

export type McpCallOptions = {
  /** How long to wait for the tool. */
  timeoutMs?: number;
  /** Aborting withdraws the call from the desktop app. */
  signal?: AbortSignal;
};

const hello = z.object({ type: z.literal("hello"), token: z.string().min(1).max(4096) });
const tokenMsg = z.object({ type: z.literal("token"), token: z.string().min(1).max(4096) });

const serverName = z.string().regex(new RegExp(`^[A-Za-z0-9_-]{1,${ML.nameChars}}$`));
const toolName = z.string().regex(new RegExp(`^[A-Za-z0-9_.-]{1,${ML.toolNameChars}}$`));
const tool = z.object({
  name: toolName,
  // Descriptions are text from a third party that goes into the model's prompt: one line, cut.
  // eslint-disable-next-line no-control-regex
  description: z.string().max(ML.descriptionChars * 2).transform((s) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, ML.descriptionChars)),
  inputSchema: z.record(z.string(), z.unknown()).refine((o) => JSON.stringify(o).length <= ML.schemaChars, "schema too large"),
});
const stateMsg = z.object({
  type: z.literal("mcp"),
  /** This app can keep custom panels (a newer app). Without it the AI is offered no panel tools. */
  panels: z.boolean().optional(),
  /** This app can run the person's own Claude Code login for an AI step, and it is switched on and signed in right now. */
  claudeCode: z.object({ ready: z.boolean() }).optional(),
  mcp: z.object({
    servers: z
      .array(z.object({ name: serverName, tools: z.array(tool).max(ML.toolsPerServer) }))
      .max(ML.servers)
      .refine((all) => new Set(all.map((x) => x.name)).size === all.length, "duplicate server"),
  }),
});
const NO_TOOLS: McpState = { servers: [] };

const ERROR_CODES = ["mcp_unavailable", "mcp_failed", "bad_request", "timeout", "busy", "expired", "failed"] as const satisfies readonly FolderErrorCode[];
// eslint-disable-next-line no-control-regex
const message = z.string().max(300).refine((s) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s), "control characters");
const response = z.discriminatedUnion("ok", [
  z.object({ id: z.string().max(64), ok: z.literal(true), result: z.object({ text: z.string().max(ML.resultChars + 200), isError: z.boolean(), truncated: z.boolean() }) }),
  z.object({ id: z.string().max(64), ok: z.literal(false), code: z.enum(ERROR_CODES), message }),
]);

// What the desktop app may send back during an AI step run with the person's Claude Code login. Everything is checked here again:
// the app is not trusted with more than text and calls to the tools this step offered.
const llmId = z.string().max(64);
const llmEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().max(CC.outputChars) }),
  z.object({ kind: z.literal("call"), id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), name: toolName, args: z.string().max(CC.argChars) }),
  z.object({ kind: z.literal("end"), finish: z.enum(["stop", "tool-calls", "length"]), usage: z.object({ input: z.number().int().min(0).max(1e9), output: z.number().int().min(0).max(1e9) }).optional() }),
]);
const llmFrame = z.object({ id: llmId, event: llmEvent });
const LLM_ERRORS = ["cc_unavailable", "cc_not_found", "cc_not_signed_in", "cc_limit", "cc_failed", "busy", "bad_request"] as const;
const llmError = z.object({ id: llmId, code: z.enum(LLM_ERRORS), message });

type Pending = { resolve: (v: McpCallResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/** One AI step that is running on the person's computer. */
type LlmRun = {
  queue: ClaudeCodeEvent[];
  wake: (() => void) | null;
  error: Error | null;
  done: boolean;
  /** Tool names this step offered: the only ones it may call. */
  offered: Set<string>;
  calls: number;
  chars: number;
  idle: ReturnType<typeof setTimeout> | null;
};

type Conn = {
  ws: WebSocket;
  /** AI steps running here for this person, by id. */
  llm: Map<string, LlmRun>;
  /** Whether the app says the person's Claude Code login can be used now. */
  claudeCode: boolean;
  /** When AI steps were started, for the flood limit. */
  llmStarted: number[];
  userId: string;
  pending: Map<string, Pending>;
  /** The tools this person's app says the AI may use. Nothing until the app says so. */
  state: McpState;
  /** Whether this person's app keeps custom panels. */
  panels: boolean;
  /** When tools were last called, for the flood limit. */
  called: number[];
};

const HELLO_MS = 10_000;
const PING_MS = 20_000;
const DEAD_MS = 70_000;
const MAX_PENDING = 16;
const MAX_CONNECTIONS = 200;
const MAX_LLM = 3;
/** AI steps one person's app may be asked for in WINDOW_MS (a long agent answer is several steps). */
const LLM_WINDOW_STEPS = 200;
const WINDOW_MS = 10 * 60_000;
/** Supabase access tokens last an hour and the app sends each refreshed one. A socket whose last token is older than this is closed. */
const TOKEN_MAX_MS = 75 * 60_000;
export const MCP_PATH = "/api/mcp-host";

export function createMcpRelay(deps: McpRelayDeps, opts: { tokenMaxMs?: number; pingMs?: number } = {}) {
  const tokenMaxMs = opts.tokenMaxMs ?? TOKEN_MAX_MS;
  const pingMs = opts.pingMs ?? PING_MS;
  const users = new Map<string, Conn>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let open = 0;

  function drop(conn: Conn, why: string) {
    for (const p of conn.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RelayError("offline", why));
    }
    conn.pending.clear();
    for (const run of conn.llm.values()) failRun(run, new ClaudeCodeError("cc_unavailable", why));
    conn.llm.clear();
    if (users.get(conn.userId) === conn) users.delete(conn.userId);
  }

  function failRun(run: LlmRun, error: Error) {
    if (run.done) return;
    run.error = error;
    run.done = true;
    if (run.idle) clearTimeout(run.idle);
    run.wake?.();
  }

  /** A step that goes quiet for too long has stalled: it is withdrawn from the app. */
  function armIdle(run: LlmRun) {
    if (run.idle) clearTimeout(run.idle);
    run.idle = run.done ? null : setTimeout(() => failRun(run, new ClaudeCodeError("cc_failed", "Claude Code stopped answering.")), CC.idleMs);
  }

  const send = (ws: WebSocket, msg: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const fail = (ws: WebSocket, code: string, closeCode: number) => {
    send(ws, { type: "error", code });
    ws.close(closeCode, code);
  };

  wss.on("connection", (ws) => {
    open++;
    let conn: Conn | null = null;
    let handling = false;
    let seen = Date.now();
    let authedAt = Date.now();
    const helloTimer = setTimeout(() => ws.close(4408, "hello"), HELLO_MS);
    const ping = setInterval(() => {
      if (Date.now() - seen > DEAD_MS) return void ws.terminate();
      // Signed out elsewhere, or the app stopped refreshing: the connection doesn't outlive its sign-in.
      if (conn && Date.now() - authedAt > tokenMaxMs) return void fail(ws, "unauthorized", 4401);
      send(ws, { type: "ping" });
    }, pingMs);

    ws.on("pong", () => (seen = Date.now()));
    ws.on("close", () => {
      open--;
      clearTimeout(helloTimer);
      clearInterval(ping);
      if (conn) drop(conn, "Your desktop app disconnected.");
    });
    ws.on("error", () => ws.terminate());

    ws.on("message", async (raw, isBinary) => {
      seen = Date.now();
      if (isBinary) return void ws.close(1003, "text only");
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return void ws.close(1008, "bad frame");
      }
      const type = (msg as { type?: unknown } | null)?.type;

      if (!conn) {
        if (handling) return;
        handling = true;
        try {
          const parsed = hello.safeParse(msg);
          if (!parsed.success) return void ws.close(1008, "hello first");
          const userId = await deps.authenticate(parsed.data.token);
          if (!userId) return fail(ws, "unauthorized", 4401);
          if (ws.readyState !== ws.OPEN) return;
          clearTimeout(helloTimer);
          authedAt = Date.now();
          const previous = users.get(userId);
          conn = { ws, userId, pending: new Map(), llm: new Map(), claudeCode: false, llmStarted: [], state: NO_TOOLS, panels: false, called: [] };
          users.set(userId, conn);
          if (previous) {
            // Another copy of this person's app took over: the older one is dropped.
            drop(previous, "Your desktop app reconnected.");
            previous.ws.close(4000, "replaced");
          }
          send(ws, { type: "ready" });
        } catch (e) {
          console.error("[mcp] hello failed:", e instanceof Error ? e.message : e);
          ws.close(1011, "error");
        } finally {
          handling = false;
        }
        return;
      }

      if (type === "res") {
        const parsed = response.safeParse((msg as { res?: unknown }).res);
        if (!parsed.success) return;
        const p = conn.pending.get(parsed.data.id);
        if (!p) return;
        conn.pending.delete(parsed.data.id);
        clearTimeout(p.timer);
        if (parsed.data.ok) p.resolve(parsed.data.result);
        else p.reject(new RelayError("host", parsed.data.message, parsed.data.code));
      } else if (type === "mcp") {
        const parsed = stateMsg.safeParse(msg);
        conn.state = parsed.success ? parsed.data.mcp : NO_TOOLS;
        conn.panels = parsed.success && parsed.data.panels === true;
        conn.claudeCode = parsed.success && parsed.data.claudeCode?.ready === true;
      } else if (type === "llm") {
        const parsed = llmFrame.safeParse(msg);
        const run = parsed.success ? conn.llm.get(parsed.data.id) : undefined;
        if (!parsed.success || !run || run.done) return;
        const ev = parsed.data.event;
        if (ev.kind === "text") {
          run.chars += ev.text.length;
          if (run.chars > CC.outputChars) return failRun(run, new ClaudeCodeError("cc_limit", "The answer was too long."));
        } else if (ev.kind === "call") {
          if (!run.offered.has(ev.name) || ++run.calls > CC.calls) return failRun(run, new ClaudeCodeError("cc_failed", "The AI asked for a tool it was not given."));
        }
        run.queue.push(ev);
        if (ev.kind === "end") run.done = true;
        armIdle(run);
        run.wake?.();
      } else if (type === "llm_err") {
        const parsed = llmError.safeParse(msg);
        const run = parsed.success ? conn.llm.get(parsed.data.id) : undefined;
        if (!parsed.success || !run) return;
        failRun(run, new ClaudeCodeError(parsed.data.code, parsed.data.message));
      } else if (type === "token") {
        // A refreshed access token: it has to belong to the same person.
        const parsed = tokenMsg.safeParse(msg);
        const userId = parsed.success ? await deps.authenticate(parsed.data.token).catch(() => null) : null;
        if (userId !== conn.userId) fail(ws, "unauthorized", 4401);
        else authedAt = Date.now();
      }
    });
  });

  function request(userId: string, frame: { op: string } & Record<string, unknown>, o: McpCallOptions): Promise<McpCallResult> {
    const conn = users.get(userId);
    if (!conn || conn.ws.readyState !== conn.ws.OPEN) return Promise.reject(new RelayError("offline", "Your desktop app is offline."));
    if (conn.pending.size >= MAX_PENDING) return Promise.reject(new RelayError("busy", "Several tool calls are already running. Try again in a moment."));
    const now = Date.now();
    conn.called = conn.called.filter((t) => now - t < WINDOW_MS);
    if (conn.called.length >= ML.windowCalls) return Promise.reject(new RelayError("busy", "Too many tool calls were made in a short time. Wait a few minutes."));
    conn.called.push(now);
    if (o.signal?.aborted) return Promise.reject(new RelayError("cancelled", "Cancelled."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        finish();
        send(conn.ws, { type: "cancel", id });
        reject(new RelayError("timeout", "The tool did not answer in time."));
      }, o.timeoutMs ?? ML.callDefaultMs + 15_000);
      const onAbort = () => {
        if (!conn.pending.delete(id)) return;
        finish();
        send(conn.ws, { type: "cancel", id });
        reject(new RelayError("cancelled", "Cancelled."));
      };
      o.signal?.addEventListener("abort", onAbort, { once: true });
      conn.pending.set(id, { resolve: (v) => (finish(), resolve(v)), reject: (e) => (finish(), reject(e)), timer });
      send(conn.ws, { type: "req", req: { id, ...frame } });
    });
  }

  return {
    /** Takes the upgrade requests for /api/mcp-host. Other paths are left to whoever else listens. */
    attach(server: Server) {
      server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if ((req.url ?? "").split("?")[0] !== MCP_PATH) return;
        // The desktop app is not a web page and sends no Origin; a browser always does. Keeping browsers out closes off cross-site WebSocket tricks.
        if (req.headers.origin !== undefined || open >= MAX_CONNECTIONS) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return void socket.destroy();
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      });
    },

    isOnline: (userId: string) => users.has(userId),

    /** The tools this person's app allows the AI to use right now. Nothing while the app is offline. */
    tools: (userId: string): McpState => users.get(userId)?.state ?? NO_TOOLS,


    /** Whether `userId`'s app says the AI may use their Claude Code login right now. */
    claudeCodeReady: (userId: string) => users.get(userId)?.claudeCode === true,

    /**
     * Runs one AI step on `userId`'s own computer with their own Claude Code login and yields what comes back. Callers pass the
     * asker's own id and nobody else's. Ends with an `end` event, or throws a ClaudeCodeError. Aborting withdraws the step.
     */
    async *claudeCode(userId: string, req: ClaudeCodeRequest, signal?: AbortSignal): AsyncGenerator<ClaudeCodeEvent> {
      const conn = users.get(userId);
      if (!conn || conn.ws.readyState !== conn.ws.OPEN) throw new ClaudeCodeError("cc_unavailable", "Your desktop app is offline.");
      if (!conn.claudeCode) throw new ClaudeCodeError("cc_unavailable", "Claude Code login is not switched on in your desktop app.");
      if (conn.llm.size >= MAX_LLM) throw new ClaudeCodeError("busy", "Several answers are already running on your Claude Code login. Try again in a moment.");
      const now = Date.now();
      conn.llmStarted = conn.llmStarted.filter((t) => now - t < WINDOW_MS);
      if (conn.llmStarted.length >= LLM_WINDOW_STEPS) throw new ClaudeCodeError("busy", "Too many answers on your Claude Code login in a short time. Wait a few minutes.");
      if (signal?.aborted) throw new ClaudeCodeError("cc_failed", "Cancelled.");
      conn.llmStarted.push(now);
      const id = randomUUID();
      const run: LlmRun = { queue: [], wake: null, error: null, done: false, offered: new Set(req.tools.map((t) => t.name)), calls: 0, chars: 0, idle: null };
      conn.llm.set(id, run);
      const total = setTimeout(() => failRun(run, new ClaudeCodeError("cc_limit", "The answer took too long.")), CC.totalMs);
      const onAbort = () => failRun(run, new ClaudeCodeError("cc_failed", "Cancelled."));
      signal?.addEventListener("abort", onAbort, { once: true });
      armIdle(run);
      send(conn.ws, { type: "req", req: { id, op: "llm", ...req } });
      try {
        for (;;) {
          const ev = run.queue.shift();
          if (ev) {
            yield ev;
            if (ev.kind === "end") return;
            continue;
          }
          if (run.error) throw run.error;
          if (run.done) return;
          await new Promise<void>((resolve) => (run.wake = resolve));
          run.wake = null;
        }
      } finally {
        clearTimeout(total);
        if (run.idle) clearTimeout(run.idle);
        signal?.removeEventListener("abort", onAbort);
        if (!run.done || run.error) send(conn.ws, { type: "cancel", id });
        run.done = true;
        conn.llm.delete(id);
      }
    },

    /** Whether this person's app is online and keeps custom panels. */
    hasPanels: (userId: string) => users.get(userId)?.panels === true,

    /** Asks `userId`'s app about their custom panels. Callers pass the asker's own id and nobody else's. */
    panel(userId: string, req: PanelRequest, o: McpCallOptions = {}): Promise<McpCallResult> {
      if (users.get(userId)?.panels !== true) return Promise.reject(new RelayError("offline", "Your desktop app is offline, or too old for custom panels."));
      return request(userId, { op: "panel", ...req }, o);
    },

    /** Calls one of `userId`'s tools. Callers pass the asker's own id and nobody else's. */
    call(userId: string, req: McpRequest, o: McpCallOptions = {}): Promise<McpCallResult> {
      return request(userId, { op: "mcp_call", ...req }, o);
    },

    close() {
      for (const conn of users.values()) conn.ws.close(1001, "shutdown");
      wss.close();
    },
  };
}

export type McpRelay = ReturnType<typeof createMcpRelay>;
