import { MCP_LIMITS as M, redactSecrets, resultText, toolEntries, type McpCallResult, type McpRemoteServer, type McpRemoteStatus, type McpState, type ToolEntry } from "@mc/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RelayError } from "./folder-relay.ts";
import { RowOAuthProvider, OAuthUnavailable, type OAuthDeps } from "./mcp-oauth.ts";
import type { RemoteRow, RemoteStore } from "./mcp-remote-store.ts";
import { BlockedAddress } from "./ssrf.ts";
import type { McpCallOptions, McpRequest } from "./mcp-relay.ts";

// Remote MCP servers: the chat server connects to the address the person added, with the sign-in they gave, and keeps
// the connection for a few minutes after the last use. A server's words are written by someone else: tool lists and
// results are cleaned the same way as for local servers (shared/mcp-text.ts), and every connection goes through the
// guarded fetch (ssrf.ts), which refuses private and internal addresses.

export type RemoteDeps = OAuthDeps & {
  /** How long a connection may sit unused before it is closed. */
  idleMs?: number;
};

type Entry = {
  rowKey: string;
  status: McpRemoteStatus;
  error?: string;
  tools: ToolEntry[];
  client: Client | null;
  lastUsed: number;
  connecting: Promise<void> | null;
};

const CONNECT_MS = 15_000;
const LIST_MS = 15_000;
const IDLE_MS = 5 * 60_000;
const WINDOW_MS = 10 * 60_000;
const MAX_TOOLS_LISTED = 200;

const ERR = {
  unreachable: "Could not reach the server.",
  blocked: "That address is blocked (private or internal network).",
  timeout: "The server did not answer in time.",
  rejected: "The server rejected the token. Replace it and try again.",
  signin: "Sign in needed.",
  notMcp: "That is not an MCP server, or it does not speak a version we support.",
  oauthOff: "OAuth sign-in is not set up on this chat server.",
} as const;

/** A fixed sentence for what went wrong. The server's own error text can hold anything and stays in our log. */
export function reasonOf(e: unknown, authKind: RemoteRow["auth_kind"]): { status: McpRemoteStatus; error: string } {
  for (let x: unknown = e, i = 0; x && i < 6; x = (x as { cause?: unknown }).cause, i++) {
    if (x instanceof BlockedAddress) return { status: "failed", error: ERR.blocked };
    if (x instanceof OAuthUnavailable) return { status: "failed", error: ERR.oauthOff };
  }
  if (e instanceof UnauthorizedError) return authKind === "oauth" ? { status: "needs_sign_in", error: ERR.signin } : { status: "failed", error: ERR.rejected };
  const code = e instanceof StreamableHTTPError ? e.code : undefined;
  if (code === 401 || code === 403) return authKind === "oauth" ? { status: "needs_sign_in", error: ERR.signin } : { status: "failed", error: ERR.rejected };
  const msg = e instanceof Error ? e.message : "";
  if (/timed out|timeout|aborted/i.test(msg)) return { status: "failed", error: ERR.timeout };
  if (code !== undefined && code >= 400 && code < 500) return { status: "failed", error: ERR.notMcp };
  if (/Invalid|schema|JSON|protocol|not supported/i.test(msg)) return { status: "failed", error: ERR.notMcp };
  return { status: "failed", error: ERR.unreachable };
}

export class RemoteMcp {
  private readonly entries = new Map<string, Entry>();
  private readonly called = new Map<string, number[]>();
  private readonly inFlight = new Map<string, number>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: RemoteDeps) {}

  private now = () => (this.d.now ?? Date.now)();

  /**
   * What about a row, if it changes, needs a new connection. Not the OAuth blob: the SDK itself rewrites it while it
   * registers, signs in and refreshes, and signing in ends with an explicit reconnect.
   */
  private rowKey = (r: RemoteRow) => `${r.url}\n${r.auth_kind}\n${r.header_name}\n${r.secret_enc}`;

  private async close(id: string) {
    const e = this.entries.get(id);
    this.entries.delete(id);
    await e?.client?.close().catch(() => undefined);
  }

  /** The server was removed or its sign-in changed: drop its connection. */
  async forget(id: string) {
    await this.close(id);
  }

  private startSweeper() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      for (const [id, e] of this.entries) if (e.client && !e.connecting && this.now() - e.lastUsed > (this.d.idleMs ?? IDLE_MS)) void this.close(id);
    }, 30_000);
    this.sweeper.unref();
  }

  private makeTransport(kind: "http" | "sse", row: RemoteRow) {
    const url = new URL(row.url);
    const headers: Record<string, string> = {};
    if (row.auth_kind === "header" && row.header_name && row.secret_enc) headers[row.header_name] = this.d.decrypt(row.secret_enc);
    const opts = { requestInit: { headers }, fetch: this.d.fetch as never, ...(row.auth_kind === "oauth" ? { authProvider: new RowOAuthProvider(this.d, row) } : {}) };
    return kind === "http" ? new StreamableHTTPClientTransport(url, opts) : new SSEClientTransport(url, opts);
  }

  /** Connects and lists the tools. Fills the entry; never throws. */
  private async open(row: RemoteRow, entry: Entry) {
    const attempt = async (kind: "http" | "sse") => {
      const client = new Client({ name: "multiuser-chat", version: "0.1.0" }, { capabilities: {} });
      try {
        await client.connect(this.makeTransport(kind, row), { timeout: CONNECT_MS });
        const listed: unknown[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: LIST_MS });
          listed.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor && listed.length < MAX_TOOLS_LISTED);
        return { client, tools: toolEntries(listed) };
      } catch (e) {
        await client.close().catch(() => undefined);
        throw e;
      }
    };
    try {
      let r;
      try {
        r = await attempt("http");
      } catch (e) {
        // Older servers speak the previous "SSE" transport: the Streamable HTTP request is answered with 400, 404 or 405.
        if (e instanceof StreamableHTTPError && [400, 404, 405].includes(e.code ?? 0)) r = await attempt("sse");
        else throw e;
      }
      entry.client = r.client;
      entry.tools = r.tools;
      entry.status = "ready";
      entry.error = undefined;
      r.client.onclose = () => {
        if (entry.client === r.client) {
          entry.client = null;
          if (entry.status === "ready") entry.status = "connecting"; // reconnected on next use
        }
      };
    } catch (e) {
      console.error("[mcp-remote] could not connect:", redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 300));
      const why = reasonOf(e, row.auth_kind);
      entry.status = why.status;
      entry.error = why.error;
      entry.client = null;
      entry.tools = [];
    }
  }

  /** The entry for a row, connecting if needed (one connection attempt at a time per server). */
  private ensure(row: RemoteRow): Entry {
    this.startSweeper();
    const key = this.rowKey(row);
    let e = this.entries.get(row.id);
    if (e && e.rowKey !== key) {
      void e.client?.close().catch(() => undefined);
      e = undefined;
    }
    if (!e) {
      e = { rowKey: key, status: "connecting", tools: [], client: null, lastUsed: this.now(), connecting: null };
      this.entries.set(row.id, e);
    }
    const entry = e;
    const needs = !entry.client && !entry.connecting && (entry.status === "connecting" || entry.status === "ready");
    if (needs) {
      entry.status = "connecting";
      entry.connecting = this.open(row, entry).finally(() => {
        entry.connecting = null;
      });
    }
    return entry;
  }

  /** Starts (or restarts) the connection and waits for it. Used right after adding, signing in, replacing a token or Try again. */
  async reconnect(row: RemoteRow): Promise<void> {
    await this.close(row.id);
    if (!row.enabled) return;
    await this.ensure(row).connecting;
  }

  // ---------------------------------------------------------------- what the page sees

  private toolViews(row: RemoteRow, e: Entry | undefined) {
    return (e?.tools ?? []).map((t) => ({ name: t.name, description: t.description, enabled: !row.disabled_tools.includes(t.name), usable: t.usable, ...(t.note ? { note: t.note } : {}) }));
  }

  view(row: RemoteRow): McpRemoteServer {
    const e = row.enabled ? this.ensure(row) : undefined;
    const status: McpRemoteStatus = !row.enabled ? "off" : e!.status;
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      authKind: row.auth_kind,
      ...(row.header_name ? { headerName: row.header_name } : {}),
      ...(row.secret_hint ? { secretHint: row.secret_hint } : {}),
      enabled: row.enabled,
      status,
      ...(e?.error && (status === "failed" || status === "needs_sign_in") ? { error: e.error } : {}),
      tools: this.toolViews(row, e),
    };
  }

  // ---------------------------------------------------------------- what the AI gets

  /** The tools of this person's enabled remote servers that are connected. Waits a little for connections that are starting. */
  async state(userId: string, waitMs = 8_000): Promise<McpState> {
    const rows = (await this.d.store.list(userId)).filter((r) => r.enabled);
    const entries = rows.map((r) => ({ row: r, entry: this.ensure(r) }));
    const pending = entries.map((x) => x.entry.connecting).filter((p): p is Promise<void> => !!p);
    if (pending.length) await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, waitMs).unref())]);
    const servers: McpState["servers"] = [];
    let total = 0;
    for (const { row, entry } of entries) {
      if (entry.status !== "ready" || !entry.client) continue;
      const tools = entry.tools.filter((t) => t.usable && !row.disabled_tools.includes(t.name)).slice(0, Math.max(0, M.tools - total));
      total += tools.length;
      if (tools.length) servers.push({ name: row.name, tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    }
    return { servers };
  }

  /** Calls one of `userId`'s remote tools. Callers pass the asker's own id and nobody else's. */
  async call(userId: string, req: McpRequest, o: McpCallOptions = {}): Promise<McpCallResult> {
    const row = (await this.d.store.list(userId)).find((r) => r.name === req.server && r.enabled);
    if (!row || row.disabled_tools.includes(req.tool)) throw new RelayError("host", "That tool is not available (the server is off or does not have it).", "mcp_unavailable");
    const entry = this.ensure(row);
    if (entry.connecting) await entry.connecting;
    const known = entry.tools.find((t) => t.name === req.tool && t.usable);
    if (entry.status !== "ready" || !entry.client || !known) throw new RelayError("host", "That tool is not available (the server is off or does not have it).", "mcp_unavailable");

    const now = this.now();
    const recent = (this.called.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= M.windowCalls) throw new RelayError("busy", "Too many tool calls were made in a short time. Wait a few minutes.");
    if ((this.inFlight.get(userId) ?? 0) >= 4) throw new RelayError("busy", "Several tool calls are already running. Try again in a moment.");
    if (JSON.stringify(req.args).length > M.argChars) throw new RelayError("host", "The tool's arguments are too large.", "bad_request");
    recent.push(now);
    this.called.set(userId, recent);
    this.inFlight.set(userId, (this.inFlight.get(userId) ?? 0) + 1);
    entry.lastUsed = now;
    try {
      return resultText(await entry.client.callTool({ name: req.tool, arguments: req.args }, undefined, { timeout: o.timeoutMs ?? M.callDefaultMs, signal: o.signal }));
    } catch (e) {
      if (o.signal?.aborted) throw new RelayError("cancelled", "Cancelled.");
      console.error("[mcp-remote] call failed:", redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 300));
      if (/timed out|timeout/i.test(e instanceof Error ? e.message : "")) throw new RelayError("timeout", "The tool did not answer in time.");
      const why = reasonOf(e, row.auth_kind);
      if (why.status === "needs_sign_in" || why.error === ERR.rejected) {
        entry.status = why.status;
        entry.error = why.error;
        throw new RelayError("host", "The server asked for a sign-in again. Tell the person to sign in under Settings > MCP servers.", "mcp_failed");
      }
      throw new RelayError("host", "The tool server failed to run that tool.", "mcp_failed");
    } finally {
      this.inFlight.set(userId, Math.max(0, (this.inFlight.get(userId) ?? 1) - 1));
    }
  }

  async closeAll() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    await Promise.all([...this.entries.keys()].map((id) => this.close(id)));
  }
}
