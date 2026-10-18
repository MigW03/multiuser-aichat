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

describe("openrouter usage", () => {
  it("uses the budget that blocks first, drops the key label, and shows spend only for an uncapped key", async () => {
    const or = await import("./openrouter-usage.ts");
    const withCap = or.normalizeKeyUsage(
      {
        data: {
          label: "sk-or-v1-abc...xyz",
          limit: 50,
          limit_remaining: 20,
          limit_reset: "monthly",
          usage: 30,
          usage_daily: 1.5,
          usage_weekly: "4",
          usage_monthly: 12,
          effective_budget: { limit_usd: 25, spend_usd: 10, remaining_usd: 15, reset_interval: "weekly", resets_at: "2026-10-19T00:00:00Z" },
        },
      },
      null,
      0,
    );
    assert.deepEqual(withCap.budget, { limit: 25, spent: 10, remaining: 15, resetInterval: "weekly", resetsAt: Date.parse("2026-10-19T00:00:00Z") / 1000 });
    assert.deepEqual(withCap.spend, { day: 1.5, week: 4, month: 12, total: 30 });
    assert.ok(!JSON.stringify(withCap).includes("sk-or"));

    const keyOnly = or.normalizeKeyUsage({ data: { limit: 50, limit_remaining: 20, limit_reset: "monthly", usage: 30 } }, null, 0);
    assert.deepEqual(keyOnly.budget, { limit: 50, spent: 30, remaining: 20, resetInterval: "monthly", resetsAt: null });

    const uncapped = or.normalizeKeyUsage({ data: { limit: null, limit_remaining: null, usage: 3.2, usage_daily: 0.1 } }, null, 0);
    assert.equal(uncapped.budget, null);
    assert.equal(uncapped.spend.total, 3.2);
    assert.equal(or.normalizeKeyUsage("junk", null, 0).spend.total, 0);
  });

  it("reads the key's own usage, tries the account balance only for uncapped keys, and ignores a refused balance", async () => {
    const or = await import("./openrouter-usage.ts");
    handler = (call) => {
      if (call.url.endsWith("/api/v1/key")) return json({ data: { limit: null, usage: 3, usage_daily: 1, usage_weekly: 2, usage_monthly: 3 } });
      if (call.url.endsWith("/api/v1/credits")) return json({ error: "management key required" }, 403);
      return json({}, 404);
    };
    const first = await or.getOpenRouterUsage("or-user", "sk-or-key");
    assert.equal(first.credits, null);
    assert.equal(calls[0]!.headers.authorization, "Bearer sk-or-key");
    assert.deepEqual(calls.map((x) => x.url), ["https://openrouter.ai/api/v1/key", "https://openrouter.ai/api/v1/credits"]);

    await or.getOpenRouterUsage("or-user", "sk-or-key");
    assert.equal(calls.length, 2, "cached");

    handler = (call) => (call.url.endsWith("/credits") ? json({ data: { total_credits: 100, total_usage: 25 } }) : json({ data: { limit: null, usage: 3 } }));
    const fresh = await or.getOpenRouterUsage("or-user", "sk-or-key", true);
    assert.deepEqual(fresh.credits, { total: 100, used: 25 });

    handler = () => json({ data: { limit: 10, usage: 1 } });
    calls = [];
    const capped = await or.getOpenRouterUsage("or-user-2", "sk-or-key");
    assert.equal(capped.budget?.limit, 10);
    assert.equal(calls.length, 1, "no balance call when the key has its own limit");
  });

  it("turns failures into messages that are safe to show", async () => {
    const or = await import("./openrouter-usage.ts");
    handler = () => json({}, 401);
    await assert.rejects(or.getOpenRouterUsage("or-user-3", "sk-or-key"), /Update it in Settings/);
    handler = () => json({}, 500);
    await assert.rejects(or.getOpenRouterUsage("or-user-3", "sk-or-key"), /could not report usage \(500\)/);
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

  it("passes function tools, tool results and encrypted reasoning through, and nothing else of that kind", () => {
    const fn = { type: "function", name: "read_file", description: "Read", parameters: { type: "object" }, strict: false };
    const shaped = c.shapeBody({
      model: "gpt-5.5",
      tools: [fn, { type: "web_search" }],
      tool_choice: "auto",
      parallel_tool_calls: false,
      include: ["reasoning.encrypted_content", "x"],
      input: [
        { role: "user", content: [{ type: "input_text", text: "what is in a.ts?" }] },
        { type: "reasoning", id: "rs_1", encrypted_content: "enc", summary: [] },
        { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' },
        { type: "function_call_output", call_id: "c1", output: "1: x" },
      ],
    });
    assert.deepEqual(shaped.tools, [fn]);
    assert.equal(shaped.tool_choice, "auto");
    assert.equal(shaped.parallel_tool_calls, false);
    assert.deepEqual(shaped.include, ["reasoning.encrypted_content"]);
    assert.equal((shaped.input as unknown[]).length, 4);
    assert.equal(shaped.store, false);
    const noTools = c.shapeBody({ model: "m", tools: [{ type: "web_search" }], tool_choice: "required", input: [] });
    assert.equal("tools" in noTools || "tool_choice" in noTools, false);
  });

  it("runs a tool loop against the backend without referring to stored items", async () => {
    const { streamText, stepCountIs, tool } = await import("ai");
    const { z } = await import("zod");
    const bodies: Record<string, unknown>[] = [];
    const sse = (events: object[]) => new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    let call = 0;
    handler = (req) => {
      bodies.push(JSON.parse(req.body));
      call++;
      if (call === 1) {
        const item = { type: "function_call", id: "fc_1", call_id: "c1", name: "read_file", arguments: '{"path":"a.ts"}', status: "completed" };
        return sse([
          { type: "response.created", response: { id: "resp_1", created_at: 1, model: "gpt-5.5" } },
          { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: item.arguments },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { incomplete_details: null, usage: { input_tokens: 3, output_tokens: 1 } } },
        ]);
      }
      return sse([
        { type: "response.created", response: { id: "resp_2", created_at: 1, model: "gpt-5.5" } },
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_2", role: "assistant", content: [] } },
        { type: "response.output_text.delta", item_id: "msg_2", output_index: 0, content_index: 0, delta: "It exports x." },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_2", role: "assistant", content: [{ type: "output_text", text: "It exports x." }] } },
        { type: "response.completed", response: { incomplete_details: null, usage: { input_tokens: 3, output_tokens: 1 } } },
      ]);
    };
    const result = streamText({
      model: c.chatgptModel(ACCESS, "gpt-5.5"),
      providerOptions: c.chatgptProviderOptions,
      messages: [{ role: "user", content: "what is in a.ts?" }],
      tools: { read_file: tool({ description: "Read", inputSchema: z.object({ path: z.string() }), execute: async () => "1: export const x = 1;" }) },
      stopWhen: stepCountIs(3),
    });
    assert.equal(await result.text, "It exports x.");
    assert.equal(bodies.length, 2);
    assert.ok(Array.isArray(bodies[0]!.tools) && (bodies[0]!.tools as unknown[]).length === 1);
    const second = JSON.stringify(bodies[1]!.input);
    assert.ok(!second.includes("item_reference"), "earlier steps are sent in full");
    assert.ok(second.includes("function_call_output") && second.includes("export const x = 1;"));
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
