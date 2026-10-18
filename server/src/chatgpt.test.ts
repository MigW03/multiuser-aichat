import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

// Run with: npm test -w server. No network and no database: fetch is replaced and logins live in memory.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SECRET_KEY = "test";
process.env.KEY_ENCRYPTION_SECRET = Buffer.alloc(32, 7).toString("base64");

type Chatgpt = typeof import("./chatgpt.ts");
type Login = import("./chatgpt.ts").StoredLogin;
let c: Chatgpt;
let crypto: typeof import("./crypto.ts");

const realFetch = globalThis.fetch;
type Call = { url: string; method: string; headers: Record<string, string>; body: string };
let calls: Call[] = [];
let handler: (call: Call) => Response | Promise<Response> = () => new Response("no handler", { status: 500 });

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const ACCESS = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } });

before(async () => {
  c = await import("./chatgpt.ts");
  crypto = await import("./crypto.ts");
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call = { url, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : "" };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  calls = [];
});

/** A login store in memory with the same lease rule as the table. */
function memoryStore() {
  const rows = new Map<string, Login & { leaseUntil: number | null }>();
  return {
    rows,
    async get(id: string) {
      const r = rows.get(id);
      return r ? { ciphertext: r.ciphertext, expiresAt: r.expiresAt, hint: r.hint } : null;
    },
    async put(id: string, l: Login) {
      rows.set(id, { ...l, leaseUntil: null });
    },
    async claimRefresh(id: string, seconds: number) {
      const r = rows.get(id);
      if (!r || (r.leaseUntil !== null && r.leaseUntil > Date.now())) return false;
      r.leaseUntil = Date.now() + seconds * 1000;
      return true;
    },
    async release(id: string) {
      const r = rows.get(id);
      if (r) r.leaseUntil = null;
    },
    async delete(id: string) {
      rows.delete(id);
    },
  };
}

const seal = (access: string, refresh: string) => crypto.encrypt(JSON.stringify({ access, refresh }));
const unseal = (l: Login) => JSON.parse(crypto.decrypt(l.ciphertext)) as { access: string; refresh: string };

describe("sign-in", () => {
  it("shows a code, waits, then saves encrypted tokens and a masked account", async () => {
    const store = memoryStore();
    let approved = false;
    handler = (call) => {
      if (call.url.endsWith("/deviceauth/usercode")) return json({ device_auth_id: "dev-1", usercode: "ABCD-1234", interval: "7" });
      if (call.url.endsWith("/deviceauth/token")) return approved ? json({ authorization_code: "code-1", code_verifier: "verifier-1" }) : json({}, 403);
      if (call.url.endsWith("/oauth/token")) return json({ access_token: ACCESS, refresh_token: "refresh-1", id_token: jwt({ email: "ana@example.com" }), expires_in: 3600 });
      return json({}, 404);
    };
    const start = await c.startSignIn("user-1");
    assert.equal(start.userCode, "ABCD-1234");
    assert.equal(start.intervalSeconds, 7);
    assert.equal(start.verificationUri, "https://auth.openai.com/codex/device");

    assert.deepEqual(await c.pollSignIn(store, "user-1", start.flow), { status: "pending" });
    assert.equal(store.rows.size, 0);

    approved = true;
    assert.deepEqual(await c.pollSignIn(store, "user-1", start.flow), { status: "connected", hint: "a•••@example.com" });
    const saved = await store.get("user-1");
    assert.ok(saved);
    assert.ok(!saved.ciphertext.includes("refresh-1"), "tokens must not be stored in the clear");
    assert.deepEqual(unseal(saved), { access: ACCESS, refresh: "refresh-1" });

    const exchange = calls.find((x) => x.url.endsWith("/oauth/token"))!;
    const form = new URLSearchParams(exchange.body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code_verifier"), "verifier-1");
    assert.equal(form.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  });

  it("rejects a flow token that was tampered with, expired, or belongs to someone else", async () => {
    handler = () => json({ device_auth_id: "dev-2", user_code: "ZZZZ" });
    const { flow } = await c.startSignIn("user-1");
    const store = memoryStore();
    await assert.rejects(c.pollSignIn(store, "user-2", flow), /expired/);
    const [body, sig] = flow.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "user-2", d: "dev-2", c: "ZZZZ", e: 9_999_999_999 })).toString("base64url");
    await assert.rejects(c.pollSignIn(store, "user-2", `${forged}.${sig}`), /expired/);
    await assert.rejects(c.pollSignIn(store, "user-1", `${body}x.${sig}`), /expired/);
    assert.equal(calls.filter((x) => x.url.endsWith("/deviceauth/token")).length, 0);
  });
});

describe("access token", () => {
  const soon = () => new Date(Date.now() + 30_000).toISOString();
  const later = () => new Date(Date.now() + 3_600_000).toISOString();

  it("is returned as is while fresh, and null when not connected", async () => {
    const store = memoryStore();
    assert.equal(await c.getAccessToken(store, "u"), null);
    await store.put("u", { ciphertext: seal("tok", "ref"), expiresAt: later(), hint: "h" });
    assert.equal(await c.getAccessToken(store, "u"), "tok");
    assert.equal(calls.length, 0);
  });

  it("refreshes once when many requests arrive together, and keeps the rotated refresh token", async () => {
    const store = memoryStore();
    await store.put("u", { ciphertext: seal("old", "ref-1"), expiresAt: soon(), hint: "h" });
    handler = async (call) => {
      await new Promise((r) => setTimeout(r, 50));
      const form = new URLSearchParams(call.body);
      return form.get("refresh_token") === "ref-1" ? json({ access_token: "new", refresh_token: "ref-2", expires_in: 3600 }) : json({ error: "refresh_token_reused" }, 400);
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => c.getAccessToken(store, "u")));
    assert.deepEqual(results, Array(6).fill("new"));
    assert.equal(calls.filter((x) => x.url.endsWith("/oauth/token")).length, 1);
    assert.deepEqual(unseal((await store.get("u"))!), { access: "new", refresh: "ref-2" });
    assert.equal(store.rows.get("u")!.hint, "h");
  });

  it("drops a login OpenAI says is dead, but keeps it through a temporary failure", async () => {
    const store = memoryStore();
    await store.put("u", { ciphertext: seal("old", "ref-1"), expiresAt: soon(), hint: "h" });
    handler = () => json({ error: "server_error" }, 500);
    await assert.rejects(c.getAccessToken(store, "u"), /try again/i);
    assert.ok(await store.get("u"), "a 500 must not log the user out");
    assert.equal(store.rows.get("u")!.leaseUntil, null, "the lease is released after a failed refresh");

    handler = () => json({ error: "invalid_grant" }, 400);
    assert.equal(await c.getAccessToken(store, "u"), null);
    assert.equal(await store.get("u"), null);
  });
});

describe("plan usage", () => {
  const NOW = Date.parse("2026-10-18T12:00:00Z");
  const payload = {
    plan_type: "plus",
    account_id: "secret-account",
    email: "ana@example.com",
    rate_limit: {
      limit_reached: false,
      primary_window: { used_percent: 41.5, limit_window_seconds: 18000, reset_after_seconds: 7200 },
      secondary_window: { used_percent: 130, limit_window_seconds: 604800, reset_at: 1_790_000_000 },
    },
    additional_rate_limits: [
      { limit_name: "Spark", metered_feature: "spark", rate_limit: { limit_reached: true, primary_window: { used_percent: "100", limit_window_seconds: 3600 } } },
      { limit_name: "Empty", rate_limit: {} },
    ],
  };

  it("keeps only usage numbers, names windows from their length, and clamps percentages", () => {
    const u = c.normalizeUsage(payload, NOW);
    assert.deepEqual(u, {
      plan: "plus",
      main: {
        name: null,
        reached: false,
        windows: [
          { label: "5 hours", usedPercent: 41.5, resetsAt: Math.floor(NOW / 1000) + 7200 },
          { label: "1 week", usedPercent: 100, resetsAt: 1_790_000_000 },
        ],
      },
      extra: [{ name: "Spark", reached: true, windows: [{ label: "1 hour", usedPercent: 100, resetsAt: null }] }],
      fetchedAt: NOW,
    });
    assert.ok(!JSON.stringify(u).includes("secret-account") && !JSON.stringify(u).includes("ana@example.com"));
  });

  it("copes with a response that has none of the fields", () => {
    assert.deepEqual(c.normalizeUsage({}, NOW), { plan: null, main: { name: null, reached: null, windows: [] }, extra: [], fetchedAt: NOW });
    assert.equal(c.normalizeUsage("nope", NOW).main.windows.length, 0);
  });

  it("asks ChatGPT with the user's own token, caches briefly, and refreshes on request", async () => {
    handler = () => json(payload);
    const first = await c.getUsage("usage-user", ACCESS);
    assert.equal(first.plan, "plus");
    const call = calls.at(-1)!;
    assert.equal(call.url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(call.headers.authorization, `Bearer ${ACCESS}`);
    assert.equal(call.headers["chatgpt-account-id"], "acct-123");
    await c.getUsage("usage-user", ACCESS);
    assert.equal(calls.length, 1, "second read comes from the cache");
    await c.getUsage("usage-user", ACCESS, true);
    assert.equal(calls.length, 2);
  });

  it("turns failures into messages that are safe to show", async () => {
    handler = () => json({}, 401);
    await assert.rejects(c.getUsage("usage-user-2", ACCESS), /Reconnect/);
    handler = () => json({}, 500);
    await assert.rejects(c.getUsage("usage-user-2", ACCESS), /could not report usage \(500\)/);
  });
});

describe("disconnect", () => {
  it("asks OpenAI to revoke the refresh token, forgets the login, and still forgets it if OpenAI is unreachable", async () => {
    const store = memoryStore();
    await store.put("u", { ciphertext: seal("tok", "ref-9"), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), hint: "h" });
    handler = () => json({});
    await c.disconnect(store, "u");
    const call = calls.find((x) => x.url === "https://auth.openai.com/oauth/revoke")!;
    assert.equal(JSON.parse(call.body).token, "ref-9");
    assert.equal(await store.get("u"), null);

    await store.put("u", { ciphertext: seal("tok", "ref-9"), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), hint: "h" });
    handler = () => {
      throw new Error("offline");
    };
    await c.disconnect(store, "u");
    assert.equal(await store.get("u"), null);
  });
});

describe("requests", () => {
  it("turns system messages into instructions and drops everything the backend rejects", () => {
    const shaped = c.shapeBody({
      model: "gpt-5.5",
      temperature: 0.7,
      max_output_tokens: 100,
      top_p: 1,
      user: "x",
      tools: [],
      include: ["x"],
      store: true,
      stream: false,
      reasoning: { effort: "low", summary: "auto" },
      input: [
        { role: "system", content: "Be brief." },
        { role: "developer", content: [{ type: "input_text", text: "Use names." }] },
        { role: "user", content: [{ type: "input_text", text: "[Ana]: hi" }] },
      ],
    });
    assert.deepEqual(shaped, {
      model: "gpt-5.5",
      instructions: "Be brief.\n\nUse names.",
      input: [{ role: "user", content: [{ type: "input_text", text: "[Ana]: hi" }] }],
      stream: true,
      store: false,
      reasoning: { effort: "low" },
    });
  });

  it("sends the AI SDK's request to ChatGPT's backend, shaped and with the account headers, and reads the answer", async () => {
    const { streamText } = await import("ai");
    const events = [
      { type: "response.created", response: { id: "resp_1", created_at: 1, model: "gpt-5.5" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Hello" }] } },
      { type: "response.completed", response: { incomplete_details: null, usage: { input_tokens: 3, output_tokens: 1 } } },
    ];
    handler = () => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

    const result = streamText({ model: c.chatgptModel(ACCESS, "gpt-5.5"), instructions: "You are in a chat.", messages: [{ role: "user", content: "[Ana]: hi" }], temperature: 0.5, maxOutputTokens: 50, reasoning: "low" });
    let text = "";
    for await (const d of result.textStream) text += d;
    assert.equal(text, "Hello");

    const call = calls.at(-1)!;
    assert.equal(call.url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(call.headers.authorization, `Bearer ${ACCESS}`);
    assert.equal(call.headers["chatgpt-account-id"], "acct-123");
    const body = JSON.parse(call.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["input", "instructions", "model", "reasoning", "store", "stream"]);
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.instructions, "You are in a chat.");
    assert.deepEqual(body.reasoning, { effort: "low" });
  });

  it("never sends the token anywhere but ChatGPT's backend", async () => {
    const model = c.chatgptModel(ACCESS, "gpt-5.5") as unknown as { config: { fetch: typeof fetch } };
    await assert.rejects(model.config.fetch("https://example.com/responses", { method: "POST", body: "{}" }), /Refusing/);
    assert.equal(calls.length, 0);
  });

  it("lists models best first with the thinking levels each one offers", async () => {
    handler = () =>
      json({
        models: [
          { slug: "b-model", display_name: "B", priority: 5, visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }] },
          { slug: "a-model", priority: 1, visibility: "list", supported_reasoning_levels: ["none", "medium"] },
          { slug: "hidden", priority: 0, visibility: "hide" },
          { slug: "bad slug!", priority: 0 },
        ],
      });
    const models = await c.listChatGptModels(ACCESS);
    assert.deepEqual(models, [
      { id: "a-model", name: "a-model", reasoning: ["off", "medium"] },
      { id: "b-model", name: "B", reasoning: ["low", "high"] },
    ]);
    assert.equal(calls[0]!.headers.authorization, `Bearer ${ACCESS}`);
  });
});
