import { MCP_LIMITS as ML, type FolderErrorCode, type McpCallResult, type McpState } from "@mc/shared";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
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
  mcp: z.object({
    servers: z
      .array(z.object({ name: serverName, tools: z.array(tool).max(ML.tools) }))
      .max(ML.servers)
      .refine((all) => new Set(all.map((x) => x.name)).size === all.length, "duplicate server")
      .refine((all) => all.reduce((n, x) => n + x.tools.length, 0) <= ML.tools, "too many tools"),
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

type Pending = { resolve: (v: McpCallResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

type Conn = {
  ws: WebSocket;
  userId: string;
  pending: Map<string, Pending>;
  /** The tools this person's app says the AI may use. Nothing until the app says so. */
  state: McpState;
  /** When tools were last called, for the flood limit. */
  called: number[];
};

const HELLO_MS = 10_000;
const PING_MS = 20_000;
const DEAD_MS = 70_000;
const MAX_PENDING = 16;
const MAX_CONNECTIONS = 200;
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
    if (users.get(conn.userId) === conn) users.delete(conn.userId);
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
          conn = { ws, userId, pending: new Map(), state: NO_TOOLS, called: [] };
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
      } else if (type === "token") {
        // A refreshed access token: it has to belong to the same person.
        const parsed = tokenMsg.safeParse(msg);
        const userId = parsed.success ? await deps.authenticate(parsed.data.token).catch(() => null) : null;
        if (userId !== conn.userId) fail(ws, "unauthorized", 4401);
        else authedAt = Date.now();
      }
    });
  });

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

    /** Calls one of `userId`'s tools. Callers pass the asker's own id and nobody else's. */
    call(userId: string, req: McpRequest, o: McpCallOptions = {}): Promise<McpCallResult> {
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
        send(conn.ws, { type: "req", req: { id, op: "mcp_call", ...req } });
      });
    },

    close() {
      for (const conn of users.values()) conn.ws.close(1001, "shutdown");
      wss.close();
    },
  };
}

export type McpRelay = ReturnType<typeof createMcpRelay>;
