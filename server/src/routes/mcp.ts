import type { McpRemoteList, McpRemoteServer } from "@mc/shared";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { rateLimit, type AuthVars } from "../auth.ts";
import { encrypt } from "../crypto.ts";
import { finishSignIn, OAuthUnavailable, signOut, startSignIn, type OAuthDeps } from "../mcp-oauth.ts";
import type { RemoteMcp } from "../mcp-remote.ts";
import { type RemoteRow, type RemoteStore, StoreError, supabaseRemoteStore as store } from "../mcp-remote-store.ts";
import { remoteDeps, remoteMcp } from "../mcp-servers.ts";
import { BlockedAddress, checkUrl } from "../ssrf.ts";

// Remote MCP servers, per person. Everything here is the signed-in person's own: every lookup is by their user id, so
// nobody can read, change or sign in to another person's server. Secrets (a header value, OAuth tokens) are encrypted
// before they are stored and never come back: the page gets a view with the last 4 characters of a header value at most.

const name = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "A name is 1 to 32 letters, digits, - or _.");
// A header the protocol or the HTTP stack owns can't be set by a person.
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "accept", "connection", "upgrade", "transfer-encoding", "te", "trailer", "keep-alive", "proxy-authorization", "proxy-connection", "mcp-session-id", "mcp-protocol-version", "last-event-id", "cookie", "origin", "referer", "user-agent", "expect"]);
const headerName = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/, "A header name is letters, digits and -.")
  .refine((h) => !RESERVED_HEADERS.has(h.toLowerCase()), "That header can't be set.");
// eslint-disable-next-line no-control-regex
const headerValue = z.string().min(1).max(2000).refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "A header value can't contain line breaks or control characters.");

const addBody = z.object({
  name,
  url: z.string().min(1).max(2000),
  auth: z.discriminatedUnion("kind", [z.object({ kind: z.literal("none") }), z.object({ kind: z.literal("header"), name: headerName, value: headerValue }), z.object({ kind: z.literal("oauth") })]),
});

const message = (e: unknown): string => {
  if (e instanceof BlockedAddress) {
    return { scheme: "The address must start with https://.", credentials: "The address can't contain a user name or password.", address: "That address is blocked (private or internal network).", invalid: "That is not a valid address.", port: "That port is not allowed." }[e.why];
  }
  if (e instanceof StoreError) return { too_many: "You can have up to 10 remote servers.", name_taken: "You already have a server with that name.", failed: "Could not save that. Try again." }[e.code];
  return "Something went wrong. Try again.";
};
const status = (e: unknown) => (e instanceof BlockedAddress ? 400 : e instanceof StoreError ? (e.code === "failed" ? 500 : 400) : 500);

const page = (title: string, text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:18vh auto;padding:0 1rem;color:#222}h1{font-size:1.25rem}</style></head><body><h1>${title}</h1><p>${text}</p></body></html>`;

export function createMcpRoutes(deps: { store: RemoteStore; remoteMcp: RemoteMcp; oauth: OAuthDeps; /** Tests only: the routes are called many times in a row. */ noRateLimits?: boolean; /** Tests only: accept an address on this machine (a fixture). Never set in production. */ allowPrivateAddresses?: boolean }) {
  const limit = (name: string, max: number, windowMs: number, by: "user" | "ip" = "user") => (deps.noRateLimits ? createMiddleware(async (_c, next) => next()) : rateLimit(name, max, windowMs, by));
  const mcpServers = new Hono<AuthVars>();
  /** The provider sends the person's browser back here, so it cannot carry a bearer token: the single-use state is the proof. */
  const mcpOauthPublic = new Hono();

  const viewOf = (row: RemoteRow): McpRemoteServer => deps.remoteMcp.view(row);

  mcpServers.get("/servers", limit("mcp-list", 60, 60_000), async (c) => {
    const rows = await deps.store.list(c.get("userId"));
    return c.json({ servers: rows.map(viewOf), oauthAvailable: !!deps.oauth.serverUrl } satisfies McpRemoteList);
  });

  mcpServers.post("/servers", limit("mcp-add", 10, 60_000), async (c) => {
    const parsed = addBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, 400);
    const { auth } = parsed.data;
    try {
      if (auth.kind === "oauth" && !deps.oauth.serverUrl) return c.json({ error: "OAuth sign-in is not set up on this chat server." }, 400);
      const url = deps.allowPrivateAddresses ? new URL(parsed.data.url) : checkUrl(parsed.data.url);
      const row = await deps.store.insert({
        user_id: c.get("userId"),
        name: parsed.data.name,
        url: url.href,
        auth_kind: auth.kind,
        header_name: auth.kind === "header" ? auth.name : null,
        secret_enc: auth.kind === "header" ? encrypt(auth.value) : null,
        secret_hint: auth.kind === "header" ? auth.value.slice(-4) : null,
      });
      void deps.remoteMcp.reconnect(row); // the page sees "connecting" and polls
      return c.json(viewOf(row), 201);
    } catch (e) {
      return c.json({ error: message(e) }, status(e));
    }
  });

  const patchBody = z.object({ enabled: z.boolean().optional(), tool: z.object({ name: z.string().min(1).max(64), enabled: z.boolean() }).optional() });

  mcpServers.patch("/servers/:id", limit("mcp-edit", 60, 60_000), async (c) => {
    const parsed = patchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    const userId = c.get("userId");
    try {
      const row = await deps.store.get(userId, c.req.param("id"));
      if (!row) return c.json({ error: "Not found" }, 404);
      const patch: Partial<RemoteRow> = {};
      if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
      if (parsed.data.tool) {
        const { name: tool, enabled } = parsed.data.tool;
        patch.disabled_tools = (enabled ? row.disabled_tools.filter((t) => t !== tool) : [...new Set([...row.disabled_tools, tool])]).slice(0, 500);
      }
      const next = await deps.store.update(userId, row.id, patch);
      if (!next) return c.json({ error: "Not found" }, 404);
      if (parsed.data.enabled === false) await deps.remoteMcp.forget(row.id);
      else if (parsed.data.enabled === true) void deps.remoteMcp.reconnect(next);
      return c.json(viewOf(next));
    } catch (e) {
      return c.json({ error: message(e) }, status(e));
    }
  });

  mcpServers.put("/servers/:id/token", limit("mcp-token", 10, 60_000), async (c) => {
    const parsed = z.object({ value: headerValue }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, 400);
    const userId = c.get("userId");
    try {
      const row = await deps.store.get(userId, c.req.param("id"));
      if (!row) return c.json({ error: "Not found" }, 404);
      if (row.auth_kind !== "header") return c.json({ error: "This server does not use a header token." }, 400);
      const next = await deps.store.update(userId, row.id, { secret_enc: encrypt(parsed.data.value), secret_hint: parsed.data.value.slice(-4) });
      if (!next) return c.json({ error: "Not found" }, 404);
      void deps.remoteMcp.reconnect(next);
      return c.json(viewOf(next));
    } catch (e) {
      return c.json({ error: message(e) }, status(e));
    }
  });

  mcpServers.delete("/servers/:id", limit("mcp-edit", 60, 60_000), async (c) => {
    try {
      const id = c.req.param("id");
      if (!(await deps.store.remove(c.get("userId"), id))) return c.json({ error: "Not found" }, 404);
      await deps.remoteMcp.forget(id);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: message(e) }, status(e));
    }
  });

  mcpServers.post("/servers/:id/retry", limit("mcp-retry", 20, 60_000), async (c) => {
    try {
      const row = await deps.store.get(c.get("userId"), c.req.param("id"));
      if (!row) return c.json({ error: "Not found" }, 404);
      void deps.remoteMcp.reconnect(row);
      return c.json(viewOf({ ...row }));
    } catch (e) {
      return c.json({ error: message(e) }, status(e));
    }
  });

  // Sign in with OAuth: returns the provider's page to open (a new tab, or the system browser in the desktop app).
  mcpServers.post("/servers/:id/oauth/start", limit("mcp-oauth", 10, 60_000), async (c) => {
    try {
      const row = await deps.store.get(c.get("userId"), c.req.param("id"));
      if (!row) return c.json({ error: "Not found" }, 404);
      if (row.auth_kind !== "oauth") return c.json({ error: "This server does not use OAuth." }, 400);
      return c.json({ url: await startSignIn(deps.oauth, row) });
    } catch (e) {
      if (e instanceof OAuthUnavailable) return c.json({ error: "OAuth sign-in is not set up on this chat server." }, 400);
      console.error("[mcp-oauth] start failed:", e instanceof Error ? e.message : e);
      return c.json({ error: e instanceof BlockedAddress ? message(e) : "Could not start the sign-in. Check the address and try again." }, e instanceof BlockedAddress ? 400 : 502);
    }
  });

  mcpServers.post("/servers/:id/signout", limit("mcp-edit", 60, 60_000), async (c) => {
    try {
      const row = await deps.store.get(c.get("userId"), c.req.param("id"));
      if (!row) return c.json({ error: "Not found" }, 404);
      await signOut(deps.oauth, row);
      await deps.remoteMcp.forget(row.id);
      const next = await deps.store.get(c.get("userId"), row.id);
      return c.json(viewOf(next ?? row));
    } catch (e) {
      return c.json({ error: message(e) }, status(e));
    }
  });

  // ------------------------------------------------------------------ the provider's redirect

  mcpOauthPublic.get("/callback", limit("mcp-callback", 30, 60_000, "ip"), async (c) => {
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code");
    const denied = c.req.query("error") !== undefined;
    const r = await finishSignIn(deps.oauth, { state, ...(code ? { code } : {}), denied });
    if (r.ok) {
      void deps.remoteMcp.reconnect(r.row);
      return c.html(page("Signed in", "You can close this tab and go back to the app."));
    }
    const text = { unknown: "This sign-in link is not valid any more. Start again from Settings.", expired: "This sign-in took too long. Start again from Settings.", denied: "The sign-in was cancelled. You can start again from Settings.", failed: "The sign-in could not be finished. Start again from Settings." }[r.reason];
    return c.html(page("Not signed in", text), 400);
  });

  return { mcpServers, mcpOauthPublic };
}

export const { mcpServers, mcpOauthPublic } = createMcpRoutes({ store, remoteMcp, oauth: remoteDeps });
