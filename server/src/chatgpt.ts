import { isReasoning, REASONING_LEVELS, type ChatGptUsage, type ModelInfo, type Reasoning, type UsageLimit, type UsageWindow } from "@mc/shared";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { decrypt, encrypt } from "./crypto.ts";
import { env } from "./env.ts";
import { ProviderError } from "./provider-error.ts";

// ChatGPT plan: the user signs in to their own ChatGPT subscription and the AI answers on that plan.
//
// UNOFFICIAL. This uses the sign-in and the backend that OpenAI's Codex command line tool uses, not an API OpenAI
// offers to apps like this one. It can stop working at any time and may go against OpenAI's terms of use.
// The sign-in is a "device code" flow, so the user types a short code on OpenAI's own page and no password or
// browser redirect ever touches this server.

const AUTH_BASE = "https://auth.openai.com";
/** The public client id of OpenAI's Codex CLI. The device code flow only works with a client OpenAI knows. */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const VERIFICATION_URI = `${AUTH_BASE}/codex/device`;
const TIMEOUT_MS = 15_000;
/** Refresh this long before the access token expires. */
const REFRESH_SKEW_MS = 120_000;
const LEASE_SECONDS = 30;
const FLOW_SECONDS = 15 * 60;

// ------------------------------------------------------------------ token storage

/** One user's stored login. The tokens are encrypted; the rest is not secret. */
export type StoredLogin = { ciphertext: string; expiresAt: string; hint: string };

/** Where logins live. The real one is a Supabase table (chatgpt-store.ts); tests use memory. */
export type LoginStore = {
  get(userId: string): Promise<StoredLogin | null>;
  /** Saves a login and clears any refresh lease. */
  put(userId: string, login: StoredLogin): Promise<void>;
  /** Atomically takes the right to refresh. False if another caller (or server) already holds it. */
  claimRefresh(userId: string, leaseSeconds: number): Promise<boolean>;
  release(userId: string): Promise<void>;
  delete(userId: string): Promise<void>;
};

type Tokens = { access: string; refresh: string };
const sealTokens = (t: Tokens) => encrypt(JSON.stringify(t));
function openTokens(ciphertext: string): Tokens | null {
  try {
    const parsed = z.object({ access: z.string().min(1), refresh: z.string().min(1) }).safeParse(JSON.parse(decrypt(ciphertext)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // encrypted with a different secret: treat as not connected so the user signs in again
  }
}

// ------------------------------------------------------------------ talking to OpenAI

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().optional(),
  expires_in: z.coerce.number().positive().optional(),
});

async function post(url: string, init: { json?: unknown; form?: Record<string, string> }): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: init.json !== undefined ? { "content-type": "application/json" } : { "content-type": "application/x-www-form-urlencoded" },
      body: init.json !== undefined ? JSON.stringify(init.json) : new URLSearchParams(init.form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError("Could not reach ChatGPT. Try again in a moment.");
  }
}

/** The error code in an OAuth error body, if there is one. Bodies are never logged or shown. */
async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error.toLowerCase();
    if (body.error && typeof body.error === "object") {
      const e = body.error as { code?: unknown; type?: unknown };
      return String(e.code ?? e.type ?? "").toLowerCase();
    }
  } catch {
    /* not JSON */
  }
  return "";
}

const DEAD_LOGIN_CODES = new Set(["invalid_grant", "invalid_token", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"]);

class LoginExpired extends Error {}

async function exchange(form: Record<string, string>): Promise<{ tokens: Tokens; expiresAt: Date; idToken?: string }> {
  const res = await post(`${AUTH_BASE}/oauth/token`, { form: { client_id: CLIENT_ID, ...form } });
  if (!res.ok) {
    const code = await errorCode(res);
    if (res.status === 401 || DEAD_LOGIN_CODES.has(code)) throw new LoginExpired();
    throw new ProviderError(`ChatGPT sign-in failed (${res.status}). Try again in a moment.`);
  }
  const parsed = tokenResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new ProviderError("ChatGPT sent an unexpected sign-in response.");
  const t = parsed.data;
  return { tokens: { access: t.access_token, refresh: t.refresh_token }, expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000), idToken: t.id_token };
}

// ------------------------------------------------------------------ JWT claims (display and routing only, never trusted)

function claims(jwt: string | undefined): Record<string, unknown> {
  try {
    const part = jwt?.split(".")[1];
    if (!part) return {};
    const json = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** ChatGPT wants the account id the access token was issued for. */
export function accountId(accessToken: string): string | null {
  const auth = claims(accessToken)["https://api.openai.com/auth"];
  const id = auth && typeof auth === "object" ? (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id : null;
  return typeof id === "string" && /^[\w-]{1,100}$/.test(id) ? id : null;
}

/** "ana@example.com" -> "a•••@example.com". The email comes from an unverified claim and is only shown to its owner. */
export function maskedAccount(idToken: string | undefined): string {
  const email = claims(idToken).email;
  if (typeof email !== "string") return "ChatGPT account";
  const at = email.indexOf("@");
  if (at < 1 || at > 120) return "ChatGPT account";
  return `${email[0]}•••${email.slice(at)}`.slice(0, 80);
}

// ------------------------------------------------------------------ sign-in (device code)

// The flow state travels in a signed token, so any server instance can finish a sign-in another one began.
const flowKey = Buffer.from(hkdfSync("sha256", Buffer.from(env.keyEncryptionSecret, "base64"), Buffer.alloc(0), "chatgpt-device-flow-v1", 32));
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function signFlow(data: { u: string; d: string; c: string; e: number }): string {
  const body = b64(JSON.stringify(data));
  return `${body}.${b64(createHmac("sha256", flowKey).update(body).digest())}`;
}

function readFlow(token: string, userId: string): { d: string; c: string } | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", flowKey).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { u?: unknown; d?: unknown; c?: unknown; e?: unknown };
    if (data.u !== userId || typeof data.d !== "string" || typeof data.c !== "string" || typeof data.e !== "number" || data.e < Date.now() / 1000) return null;
    return { d: data.d, c: data.c };
  } catch {
    return null;
  }
}

const deviceCode = z.object({
  device_auth_id: z.string().min(1).max(500),
  user_code: z.string().min(1).max(40).optional(),
  usercode: z.string().min(1).max(40).optional(),
  interval: z.coerce.number().min(1).max(60).optional(),
});

export async function startSignIn(userId: string) {
  const res = await post(`${AUTH_BASE}/api/accounts/deviceauth/usercode`, { json: { client_id: CLIENT_ID } });
  if (res.status === 404) throw new ProviderError("ChatGPT sign-in by code is not available right now.");
  if (!res.ok) throw new ProviderError(`ChatGPT sign-in could not start (${res.status}). Try again in a moment.`);
  const parsed = deviceCode.safeParse(await res.json().catch(() => null));
  const userCode = parsed.success ? (parsed.data.user_code ?? parsed.data.usercode) : undefined;
  if (!parsed.success || !userCode) throw new ProviderError("ChatGPT sent an unexpected sign-in response.");
  return {
    flow: signFlow({ u: userId, d: parsed.data.device_auth_id, c: userCode, e: Math.floor(Date.now() / 1000) + FLOW_SECONDS }),
    userCode,
    // Always OpenAI's own page: nothing the response says can point the user anywhere else.
    verificationUri: VERIFICATION_URI,
    intervalSeconds: parsed.data.interval ?? 5,
    expiresInSeconds: FLOW_SECONDS,
  };
}

const deviceGrant = z.object({ authorization_code: z.string().min(1), code_verifier: z.string().min(1) });

/** Checks whether the user has approved the code. When they have, trades it for tokens and saves them. */
export async function pollSignIn(store: LoginStore, userId: string, flow: string): Promise<{ status: "pending" } | { status: "connected"; hint: string }> {
  const state = readFlow(flow, userId);
  if (!state) throw new ProviderError("This sign-in has expired. Start again.");
  const res = await post(`${AUTH_BASE}/api/accounts/deviceauth/token`, { json: { device_auth_id: state.d, user_code: state.c } });
  if (res.status === 403 || res.status === 404) return { status: "pending" };
  if (!res.ok) throw new ProviderError(`ChatGPT sign-in failed (${res.status}). Start again.`);
  const grant = deviceGrant.safeParse(await res.json().catch(() => null));
  if (!grant.success) throw new ProviderError("ChatGPT sent an unexpected sign-in response.");
  let result;
  try {
    result = await exchange({ grant_type: "authorization_code", code: grant.data.authorization_code, code_verifier: grant.data.code_verifier, redirect_uri: `${AUTH_BASE}/deviceauth/callback` });
  } catch (e) {
    if (e instanceof LoginExpired) throw new ProviderError("ChatGPT did not accept the sign-in. Start again.");
    throw e;
  }
  const hint = maskedAccount(result.idToken);
  usageCache.delete(userId);
  await store.put(userId, { ciphertext: sealTokens(result.tokens), expiresAt: result.expiresAt.toISOString(), hint });
  return { status: "connected", hint };
}

// ------------------------------------------------------------------ using the login

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fresh = (login: StoredLogin) => new Date(login.expiresAt).getTime() - Date.now() > REFRESH_SKEW_MS;

/**
 * A working access token for this user's ChatGPT plan, refreshed if it is about to expire. Null when they have not
 * connected one (or the login died and had to be dropped). Refresh tokens rotate, so exactly one caller refreshes at
 * a time, across servers too; the rest wait and read the result.
 */
export async function getAccessToken(store: LoginStore, userId: string): Promise<string | null> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const login = await store.get(userId);
    if (!login) return null;
    const tokens = openTokens(login.ciphertext);
    if (!tokens) return null;
    if (fresh(login)) return tokens.access;

    if (await store.claimRefresh(userId, LEASE_SECONDS)) {
      try {
        const again = await store.get(userId); // someone may have finished between our read and the claim
        const current = again ? openTokens(again.ciphertext) : null;
        if (!again || !current) return null;
        if (fresh(again)) {
          await store.release(userId);
          return current.access;
        }
        const next = await exchange({ grant_type: "refresh_token", refresh_token: current.refresh });
        await store.put(userId, { ciphertext: sealTokens(next.tokens), expiresAt: next.expiresAt.toISOString(), hint: again.hint });
        return next.tokens.access;
      } catch (e) {
        if (e instanceof LoginExpired) {
          await store.delete(userId); // the login is dead for good: show "not connected" so the user signs in again
          return null;
        }
        await store.release(userId);
        throw e;
      }
    }
    if (Date.now() > deadline) throw new ProviderError("ChatGPT is busy refreshing your sign-in. Try again in a moment.");
    await sleep(500);
  }
}

// ------------------------------------------------------------------ plan usage (read only, uses no quota)

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_CACHE_MS = 45_000;
const USAGE_CACHE_MAX = 256;
const usageCache = new Map<string, ChatGptUsage>();

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** "5 hours", "1 week": named from the window's real length, never assumed. */
export function windowLabel(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "Limit";
  const minutes = Math.round(seconds / 60);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (minutes % (7 * 24 * 60) === 0) return plural(minutes / (7 * 24 * 60), "week");
  if (minutes % (24 * 60) === 0) return plural(minutes / (24 * 60), "day");
  if (minutes % 60 === 0) return plural(minutes / 60, "hour");
  return plural(minutes, "minute");
}

function normalizeWindow(raw: unknown, now: number): UsageWindow | null {
  const w = obj(raw);
  if (Object.keys(w).length === 0) return null;
  const used = num(w.used_percent);
  const resetAt = num(w.reset_at);
  const resetAfter = num(w.reset_after_seconds);
  return {
    label: windowLabel(num(w.limit_window_seconds)),
    usedPercent: used === null ? null : Math.max(0, Math.min(100, used)),
    resetsAt: resetAt !== null && resetAt > 0 ? Math.floor(resetAt) : resetAfter !== null && resetAfter >= 0 ? Math.floor(now / 1000 + resetAfter) : null,
  };
}

function normalizeLimit(raw: unknown, name: string | null, now: number): UsageLimit {
  const d = obj(raw);
  const windows = Object.keys(d)
    .filter((k) => k.endsWith("_window"))
    .sort((a, b) => (a === "primary_window" ? -1 : b === "primary_window" ? 1 : a === "secondary_window" ? -1 : b === "secondary_window" ? 1 : 0))
    .flatMap((k) => normalizeWindow(d[k], now) ?? []);
  return { name, reached: typeof d.limit_reached === "boolean" ? d.limit_reached : null, windows };
}

/** Only these non-secret fields leave this function; anything else in the response is dropped. */
export function normalizeUsage(payload: unknown, now = Date.now()): ChatGptUsage {
  const p = obj(payload);
  const extra = (Array.isArray(p.additional_rate_limits) ? p.additional_rate_limits : []).slice(0, 20).flatMap((entry) => {
    const e = obj(entry);
    const limit = normalizeLimit(e.rate_limit, str(e.limit_name) ?? str(e.metered_feature), now);
    return limit.windows.length ? [limit] : [];
  });
  return { plan: str(p.plan_type), main: normalizeLimit(p.rate_limit, null, now), extra, fetchedAt: now };
}

/** The plan's usage for this user, cached for a short while. Throws ProviderError with a message safe to show. */
export async function getUsage(userId: string, accessToken: string, refresh = false): Promise<ChatGptUsage> {
  const cached = usageCache.get(userId);
  if (cached && !refresh && Date.now() - cached.fetchedAt < USAGE_CACHE_MS) return cached;
  let res: Response;
  try {
    res = await fetch(USAGE_URL, {
      headers: { ...chatgptHeaders(accessToken), authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new ProviderError("Could not reach ChatGPT. Try again in a moment.");
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError("ChatGPT rejected this sign-in. Reconnect it in Settings.");
  if (res.status === 429) throw new ProviderError("ChatGPT is limiting usage checks for a moment. Try again shortly.");
  if (!res.ok) throw new ProviderError(`ChatGPT could not report usage (${res.status}).`);
  const json = await res.json().catch(() => null);
  if (!json || typeof json !== "object") throw new ProviderError("ChatGPT sent an unexpected usage response.");
  const usage = normalizeUsage(json);
  if (usageCache.size >= USAGE_CACHE_MAX) usageCache.delete(usageCache.keys().next().value!);
  usageCache.set(userId, usage);
  return usage;
}

/** Signs out: asks OpenAI to revoke the refresh token (best effort, like Codex's logout), then forgets the login. */
export async function disconnect(store: LoginStore, userId: string): Promise<void> {
  const login = await store.get(userId);
  const tokens = login ? openTokens(login.ciphertext) : null;
  if (tokens) {
    try {
      await fetch(`${AUTH_BASE}/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: tokens.refresh, token_type_hint: "refresh_token", client_id: CLIENT_ID }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      /* the user can still revoke it in their ChatGPT settings */
    }
  }
  usageCache.delete(userId);
  await store.delete(userId);
}

// ------------------------------------------------------------------ requests

/** Headers ChatGPT's backend expects from a signed-in client. */
export function chatgptHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    origin: "https://chatgpt.com",
    referer: "https://chatgpt.com/codex",
    "user-agent": "multiuser-chat",
  };
  const account = accountId(accessToken);
  if (account) headers["chatgpt-account-id"] = account;
  return headers;
}

type InputItem = { role?: unknown; content?: unknown; [key: string]: unknown };

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("\n")
      : "";

/**
 * The backend takes inference only: model, instructions, input, stream, store and reasoning. Everything else the AI SDK
 * adds (temperature, token limits, tools, ...) is rejected, and system messages must be `instructions`.
 */
export function shapeBody(body: Record<string, unknown>): Record<string, unknown> {
  const input = Array.isArray(body.input) ? (body.input as InputItem[]) : [];
  const instructions: string[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) instructions.push(body.instructions);
  const rest: InputItem[] = [];
  for (const item of input) {
    if (item && (item.role === "system" || item.role === "developer")) {
      const text = textOf(item.content).trim();
      if (text) instructions.push(text);
    } else {
      rest.push(item);
    }
  }
  const out: Record<string, unknown> = {
    model: body.model,
    instructions: instructions.join("\n\n") || "You are a helpful assistant.",
    input: rest,
    stream: true,
    store: false,
  };
  const effort = (body.reasoning as { effort?: unknown } | undefined)?.effort;
  if (typeof effort === "string" && effort) out.reasoning = { effort };
  return out;
}

/** Only ever talks to ChatGPT's backend, so the access token cannot be sent anywhere else. */
async function chatgptFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(`${CHATGPT_BASE_URL}/`)) throw new Error("Refusing to send ChatGPT credentials to another address.");
  const raw = typeof init?.body === "string" ? init.body : undefined;
  if (!raw) return fetch(input, init);
  return fetch(input, { ...init, body: JSON.stringify(shapeBody(JSON.parse(raw) as Record<string, unknown>)) });
}

export function chatgptModel(accessToken: string, modelId: string): LanguageModel {
  return createOpenAI({ apiKey: accessToken, baseURL: CHATGPT_BASE_URL, headers: chatgptHeaders(accessToken), fetch: chatgptFetch }).responses(modelId);
}

type RemoteModel = {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  priority?: unknown;
  supported_reasoning_levels?: unknown;
};

function levelsOf(raw: unknown): Reasoning[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const found = new Set<Reasoning>();
  for (const entry of raw) {
    const name = typeof entry === "string" ? entry : entry && typeof entry === "object" ? (entry as { effort?: unknown; level?: unknown }).effort ?? (entry as { level?: unknown }).level : undefined;
    const level = typeof name === "string" ? (name.toLowerCase() === "none" ? "off" : name.toLowerCase()) : "";
    if (isReasoning(level)) found.add(level);
  }
  return REASONING_LEVELS.filter((l) => found.has(l));
}

/** The models this ChatGPT plan can use right now, best first. */
export async function listChatGptModels(accessToken: string): Promise<ModelInfo[]> {
  let res: Response;
  try {
    res = await fetch(`${CHATGPT_BASE_URL}/models?client_version=1.0.0`, {
      headers: { ...chatgptHeaders(accessToken), authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError("Could not reach ChatGPT. Try again in a moment.");
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError("ChatGPT rejected this sign-in. Reconnect it in Settings.");
  if (!res.ok) throw new ProviderError(`ChatGPT returned an error (${res.status}).`);
  const json = (await res.json().catch(() => null)) as { models?: unknown } | null;
  const models = Array.isArray(json?.models) ? (json.models as RemoteModel[]) : [];
  return models
    .filter((m): m is RemoteModel & { slug: string } => !!m && typeof m === "object" && typeof m.slug === "string" && /^[\w./:@+-]{1,100}$/.test(m.slug))
    .filter((m) => !["hide", "hidden"].includes(String(m.visibility ?? "").toLowerCase()))
    .sort((a, b) => (typeof a.priority === "number" ? a.priority : 1e4) - (typeof b.priority === "number" ? b.priority : 1e4))
    .map((m) => ({ id: m.slug, name: typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim().slice(0, 80) : m.slug, reasoning: levelsOf(m.supported_reasoning_levels) }));
}
