import type { ChangePreview, FolderCaps, FolderResponse } from "@mc/shared";
import { answer, type Item, type Search } from "./folder-items.ts";

// The host's side of the shared folder. For each linked project this app keeps one outgoing WebSocket to the chat
// server. The server sends read requests down it (after checking who asked) and this app answers from the linked
// folder. Nothing is listening on this computer, and the renderer (the web page) cannot read the folder: it can
// only ask this module for status.

export type FolderState = "off" | "connecting" | "connected" | "rejected" | "auth";

export type HostSession = { serverUrl: string; token: string; userId: string; hostProjects: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/**
 * "scheme://host[:port]" of a page address. Node's URL gives the custom app:// scheme the origin "null", so the
 * origin is built by hand; any address that doesn't parse gives null.
 */
export function originOf(url: string | undefined): string | null {
  try {
    const u = new URL(url ?? "");
    return u.host ? `${u.protocol}//${u.host}` : null;
  } catch {
    return null;
  }
}

/** The chat server addresses this app may connect to. Keep in step with the page's connect-src. Local servers are for development builds. */
export function serverSocketUrl(serverUrl: string, packaged: boolean, path = "/api/folder-host"): string | null {
  let u: URL;
  try {
    u = new URL(serverUrl);
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol === "https:" && u.hostname.endsWith(".fly.dev")) return `wss://${u.host}${path}`;
  if (!packaged && u.protocol === "http:" && local) return `ws://${u.host}${path}`;
  return null;
}

const MAX_IN_FLIGHT = 3;
const MAX_QUEUED = 20;
/** Largest frame from the server. Reads are tiny; the room is for the text of an AI edit or whole-file write (checked again per field). */
const MAX_FRAME_CHARS = 1_300_000;
/** The server pings every 20 s. Silence for longer than this means the connection is dead. */
const SILENCE_MS = 70_000;
const REJECTED_RETRY_MS = 5 * 60_000;

type ConnOptions = {
  projectId: string;
  wsUrl: string;
  getToken: () => string;
  /** What is shared right now. Read on every request, so adding or removing an item needs no reconnect. */
  getItems: () => Item[];
  search: Search;
  onState: (state: FolderState) => void;
  /** What the host allows the AI to propose. Sent to the server on connect and when it changes. */
  getCaps: () => FolderCaps;
  /** An AI edit or write: stages it, shows the host, and resolves when the host decides. `preview` reports the diff as soon as it exists. */
  propose: (req: unknown, preview: (change: ChangePreview) => void) => Promise<FolderResponse | null>;
  /** The server withdrew a proposal. */
  cancel: (id: string) => void;
  /** The connection ended: proposals that were waiting on it are dropped. */
  cancelAll: () => void;
};

/** One project's connection. Reconnects on its own until `close()`, unless the server says this app may not serve the folder. */
export class FolderConn {
  state: FolderState = "connecting";
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private closed = false;
  private inFlight = 0;
  private queue: unknown[] = [];

  constructor(private readonly o: ConnOptions) {
    this.open();
  }

  private set(state: FolderState) {
    if (this.state === state) return;
    this.state = state;
    this.o.onState(state);
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
      ws.send(JSON.stringify({ type: "hello", token: this.o.getToken(), projectId: this.o.projectId }));
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
        this.capsChanged();
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      } else if (msg.type === "error") {
        // not_host / not_linked: retrying won't help until the person links again. unauthorized: wait for a fresh token.
        this.set(msg.code === "unauthorized" ? "auth" : "rejected");
      } else if (msg.type === "req" && this.state === "connected") {
        const op = (msg.req as { op?: unknown } | null)?.op;
        if (op === "edit" || op === "write" || op === "git_change" || op === "exec") this.propose(msg.req);
        else this.enqueue(msg.req);
      } else if (msg.type === "cancel" && typeof msg.id === "string" && msg.id.length <= 64) {
        this.o.cancel(msg.id);
      }
    };
    ws.onclose = () => {
      clearTimeout(this.watchdog);
      this.ws = null;
      this.queue = [];
      this.o.cancelAll();
      if (this.closed) return;
      if (this.state === "auth") return; // waits for a fresh token (tokenChanged)
      if (this.state === "rejected") {
        // Not the host, or the folder isn't registered: check again now and then, not in a tight loop.
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.open(), REJECTED_RETRY_MS);
        return;
      }
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
    if (this.state === "auth") {
      this.set("connecting");
      this.open();
    } else if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "token", token: this.o.getToken() }));
    }
  }

  /** Tells the server what the host allows. */
  capsChanged() {
    if (this.ws?.readyState === WebSocket.OPEN && this.state === "connected") this.ws.send(JSON.stringify({ type: "caps", caps: this.o.getCaps() }));
  }

  /** Proposals wait for a person, so they don't count against the three reads in flight. */
  private propose(req: unknown) {
    const id = (req as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 64) return;
    void this.o
      .propose(req, (change) => this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: "event", id, event: "pending", change })))
      .then((res) => res && this.send(res))
      .catch((e) => {
        console.error("[folder] proposal failed:", e instanceof Error ? e.message : e);
        this.send({ id, ok: false, code: "failed", message: "The change couldn't be prepared." });
      });
  }

  private enqueue(req: unknown) {
    const id = (req as { id?: unknown } | null)?.id;
    if (this.queue.length >= MAX_QUEUED) {
      if (typeof id === "string" && id.length <= 64) this.send({ id, ok: false, code: "busy", message: "The shared folder is busy. Try again in a moment." });
      return;
    }
    this.queue.push(req);
    this.pump();
  }

  private pump() {
    while (this.inFlight < MAX_IN_FLIGHT && this.queue.length > 0) {
      const req = this.queue.shift();
      this.inFlight++;
      void answer(this.o.getItems(), req, this.o.search, this.o.getCaps())
        .then((res) => res && this.send(res))
        .finally(() => {
          this.inFlight--;
          this.pump();
        });
    }
  }

  private send(res: FolderResponse) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "res", res }));
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.watchdog);
    this.ws?.close();
    this.ws = null;
    this.o.cancelAll();
  }
}
