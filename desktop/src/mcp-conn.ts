import type { FolderResponse, McpState } from "@mc/shared";

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
  onLink: (link: McpLink) => void;
};

/** Largest frame from the server: a call's arguments (checked again per field by the host). */
const MAX_FRAME_CHARS = 300_000;
/** The server pings every 20 s. Silence for longer than this means the connection is dead. */
const SILENCE_MS = 70_000;
/** Tool calls in flight at once; the host's switches check again, this keeps a flood off the servers. */
const MAX_CALLS = 4;

export class McpConn {
  link: McpLink = "connecting";
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private closed = false;
  private readonly calls = new Map<string, AbortController>();

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
      }
    };
    ws.onclose = () => {
      clearTimeout(this.watchdog);
      this.ws = null;
      for (const c of this.calls.values()) c.abort();
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

  /** Tells the server which tools the AI may use for this person. */
  stateChanged() {
    if (this.ws?.readyState === WebSocket.OPEN && this.link === "connected") this.ws.send(JSON.stringify({ type: "mcp", mcp: this.o.getState() }));
  }

  private run(req: unknown) {
    const id = (req as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 64) return;
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

  private send(res: FolderResponse) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "res", res }));
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.watchdog);
    for (const c of this.calls.values()) c.abort();
    this.ws?.close();
    this.ws = null;
  }
}
