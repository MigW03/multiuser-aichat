import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { randomBytes } from "node:crypto";
import type { RemoteRow, RemoteStore } from "./mcp-remote-store.ts";

// OAuth for remote MCP servers, done by the chat server so it is the same in the web and desktop apps (opencode's flow:
// discovery, dynamic client registration or none, PKCE). The person is sent to the provider's own page and comes back to
// this server's callback. Everything the provider gives us (client registration, tokens, the PKCE verifier) is one
// encrypted blob on the person's row; the page never sees any of it.

type Blob = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string };

export type OAuthDeps = {
  store: RemoteStore;
  encrypt: (plain: string) => string;
  decrypt: (cipher: string) => string;
  /** This server's own public address, the base of the redirect URI. null = OAuth is off. */
  serverUrl: string | null;
  fetch: typeof fetch;
  now?: () => number;
  /** Tests only: accept a provider page that is not https (a fixture on this machine). Never set in production. */
  allowInsecureAuthUrl?: boolean;
};

export const STATE_MS = 10 * 60_000;
export const CALLBACK_PATH = "/api/mcp/oauth/callback";

export class OAuthUnavailable extends Error {}

/** The provider the MCP SDK drives for one server row. */
export class RowOAuthProvider implements OAuthClientProvider {
  private blob: Blob;
  /** The stored blob could not be read (encrypted with another secret). Only a sign-in the person starts may replace it. */
  private unreadable = false;
  /** Set when the SDK asks us to send the person to the provider. */
  authUrl: URL | null = null;

  /**
   * `signIn`: this provider belongs to a sign-in the person started (start or callback). A provider that only keeps a
   * connection alive never replaces a blob it cannot read, and never touches the pending sign-in (state, verifier).
   */
  constructor(
    private readonly d: OAuthDeps,
    private readonly row: RemoteRow,
    private readonly signIn = false,
  ) {
    if (!d.serverUrl) throw new OAuthUnavailable("OAuth is not set up on this chat server.");
    try {
      this.blob = row.oauth_enc ? (JSON.parse(d.decrypt(row.oauth_enc)) as Blob) : {};
    } catch {
      this.blob = {}; // encrypted with another secret: the person signs in again
      this.unreadable = true;
    }
  }

  get redirectUrl() {
    return `${this.d.serverUrl}${CALLBACK_PATH}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Nido",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /**
   * Changes the blob as it is stored NOW, not as this provider read it when it was made. Another connection (or another
   * copy of the server on the same database) may have refreshed the tokens since, and providers that overwrite each
   * other lose a refresh token the provider has already used up: the person is signed out.
   */
  private async change(fn: (stored: Blob, held: Blob) => void) {
    const held = this.blob;
    const fresh = await this.d.store.get(this.row.user_id, this.row.id);
    if (!fresh || fresh.auth_kind !== "oauth") return; // removed or changed meanwhile: nothing to keep
    let stored: Blob;
    try {
      stored = fresh.oauth_enc ? (JSON.parse(this.d.decrypt(fresh.oauth_enc)) as Blob) : {};
    } catch {
      if (!this.signIn) return; // not ours to replace
      stored = {};
    }
    if (!fresh.oauth_enc && !this.signIn && held.tokens) return; // signed out while this connection was open
    fn(stored, held);
    this.blob = stored;
    this.unreadable = false;
    await this.d.store.update(this.row.user_id, this.row.id, { oauth_enc: this.d.encrypt(JSON.stringify(stored)) });
  }

  /** A fresh single-use state for the sign-in that is starting, kept on the row for ten minutes. */
  async state(): Promise<string> {
    const state = randomBytes(32).toString("hex");
    // A connection that is only trying to stay alive must not replace the state of a sign-in the person started.
    if (!this.signIn) return state;
    const now = (this.d.now ?? Date.now)();
    await this.d.store.update(this.row.user_id, this.row.id, { oauth_state: state, oauth_state_expires: new Date(now + STATE_MS).toISOString() });
    return state;
  }

  clientInformation() {
    return this.blob.client;
  }
  async saveClientInformation(info: OAuthClientInformationMixed) {
    this.blob.client = info;
    // A registration that is already stored stays: the tokens and a sign-in in progress belong to that client.
    await this.change((stored) => void (stored.client ??= info));
  }
  tokens() {
    return this.blob.tokens;
  }
  async saveTokens(tokens: OAuthTokens) {
    this.blob.tokens = tokens;
    await this.change((stored) => void (stored.tokens = tokens));
  }
  redirectToAuthorization(url: URL) {
    this.authUrl = url;
  }
  async saveCodeVerifier(v: string) {
    this.blob.verifier = v;
    if (!this.signIn) return; // only a sign-in the person started keeps its verifier
    await this.change((stored) => void (stored.verifier = v));
  }
  codeVerifier() {
    if (!this.blob.verifier) throw new Error("no code verifier");
    return this.blob.verifier;
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "discovery") return;
    const heldRefresh = this.blob.tokens?.refresh_token;
    const heldClient = this.blob.client?.client_id;
    await this.change((stored) => {
      // The provider rejected what THIS provider held. If the stored copy is newer (another connection refreshed first),
      // keep it: it is not the one that was rejected.
      const tokensNewer = !!stored.tokens?.refresh_token && !!heldRefresh && stored.tokens.refresh_token !== heldRefresh;
      const clientNewer = !!stored.client?.client_id && !!heldClient && stored.client.client_id !== heldClient;
      if ((scope === "all" || scope === "client") && !clientNewer) delete stored.client;
      if ((scope === "all" || scope === "tokens") && !tokensNewer) delete stored.tokens;
      if (scope === "all" || scope === "verifier") delete stored.verifier;
    });
  }

  /** Whether tokens are stored (the person has signed in). */
  get signedIn() {
    return !!this.blob.tokens;
  }
}

/** Starts a sign-in. Returns the provider's page to send the person to, or null when they are already signed in. */
export async function startSignIn(d: OAuthDeps, row: RemoteRow): Promise<string | null> {
  const provider = new RowOAuthProvider(d, row, true);
  const result = await auth(provider, { serverUrl: row.url, fetchFn: d.fetch });
  if (result === "AUTHORIZED") return null;
  const url = provider.authUrl;
  if (!url || (url.protocol !== "https:" && !d.allowInsecureAuthUrl)) throw new Error("The provider did not give a usable sign-in address.");
  return url.href;
}

export type FinishResult = { ok: true; row: RemoteRow } | { ok: false; reason: "unknown" | "expired" | "denied" | "failed" };

/** The provider sent the person back. `state` is single use and short lived; `code` is exchanged for tokens. */
export async function finishSignIn(d: OAuthDeps, input: { state: string; code?: string; denied?: boolean }): Promise<FinishResult> {
  if (!/^[0-9a-f]{64}$/.test(input.state)) return { ok: false, reason: "unknown" };
  const row = await d.store.byState(input.state);
  if (!row) return { ok: false, reason: "unknown" };
  // Single use, whatever happens next.
  const cleared = await d.store.update(row.user_id, row.id, { oauth_state: null, oauth_state_expires: null });
  if (!cleared) return { ok: false, reason: "unknown" };
  const now = (d.now ?? Date.now)();
  if (!row.oauth_state_expires || Date.parse(row.oauth_state_expires) < now) return { ok: false, reason: "expired" };
  if (input.denied || !input.code) return { ok: false, reason: "denied" };
  try {
    const provider = new RowOAuthProvider(d, cleared, true);
    await auth(provider, { serverUrl: cleared.url, authorizationCode: input.code, fetchFn: d.fetch });
    // The provider saved the tokens on the row while it worked: hand back the row as it is now, not the snapshot from before.
    const fresh = await d.store.get(cleared.user_id, cleared.id);
    return provider.signedIn && fresh ? { ok: true, row: fresh } : { ok: false, reason: "failed" };
  } catch (e) {
    console.error("[mcp-oauth] sign-in could not be finished:", e instanceof Error ? e.message.slice(0, 300) : "unknown error");
    return { ok: false, reason: "failed" };
  }
}

/** Forgets the stored sign-in. */
export async function signOut(d: OAuthDeps, row: RemoteRow): Promise<void> {
  await d.store.update(row.user_id, row.id, { oauth_enc: null, oauth_state: null, oauth_state_expires: null });
}

export { type OAuthClientProvider };
