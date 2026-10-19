import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { RelayError } from "./folder-relay.ts";
import { finishSignIn, signOut, startSignIn, STATE_MS, type OAuthDeps } from "./mcp-oauth.ts";
import { RemoteMcp, reasonOf } from "./mcp-remote.ts";
import type { RemoteRow } from "./mcp-remote-store.ts";
import { startFixture, type Fixture } from "./test-fixtures/http-mcp-server.ts";
import { BlockedAddress, createGuardedFetch } from "./ssrf.ts";

const ANA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";

import { decrypt, encrypt, memoryStore } from "./test-fixtures/memory-store.ts";

const local = createGuardedFetch({ allowPrivate: true });
const fixtures: Fixture[] = [];
const managers: RemoteMcp[] = [];
after(async () => {
  await Promise.all(managers.map((m) => m.closeAll()));
  await Promise.all(fixtures.map((f) => f.close()));
});

async function setup(auth: "none" | "header" | "oauth" = "none", extra: Partial<RemoteRow> = {}, deps: Partial<OAuthDeps> = {}) {
  const fx = await startFixture({ auth });
  fixtures.push(fx);
  const store = memoryStore();
  const d: OAuthDeps = { store, encrypt, decrypt, serverUrl: "http://127.0.0.1:9", fetch: local, allowInsecureAuthUrl: true, ...deps };
  const mcp = new RemoteMcp({ ...d, idleMs: 200 });
  managers.push(mcp);
  const row = await store.insert({ user_id: ANA, name: "remote", url: fx.url, auth_kind: auth, header_name: auth === "header" ? "X-Api-Key" : null, secret_enc: auth === "header" ? encrypt("s3cret") : null, secret_hint: auth === "header" ? "cret" : null, ...extra });
  return { fx, store, mcp, row, d };
}

const rejects = (p: Promise<unknown>, kind: string, code?: string) => assert.rejects(p, (e: unknown) => e instanceof RelayError && e.kind === kind && (code === undefined || e.code === code), `expected ${kind} ${code ?? ""}`);

describe("a server with no sign-in", () => {
  test("connects, lists its tools, and calls them", async () => {
    const { mcp, row } = await setup();
    await mcp.reconnect(row);
    const view = mcp.view(row);
    assert.equal(view.status, "ready");
    assert.deepEqual(view.tools.map((t) => t.name).sort(), ["big", "boom", "echo", "slow"]);
    const state = await mcp.state(ANA);
    assert.deepEqual(state.servers.map((s) => s.name), ["remote"]);
    assert.deepEqual(state.servers[0]!.tools.find((t) => t.name === "echo")!.inputSchema.required, ["text"]);
    assert.deepEqual(await mcp.call(ANA, { server: "remote", tool: "echo", args: { text: "hi" } }), { text: "echo: hi", isError: false, truncated: false });
    assert.equal((await mcp.call(ANA, { server: "remote", tool: "boom", args: {} })).isError, true);
    const big = await mcp.call(ANA, { server: "remote", tool: "big", args: {} });
    assert.equal(big.truncated, true);
    assert.equal(big.text.length, 50_000);
  });

  test("tools can be switched off per tool and per server; the AI no longer sees or reaches them", async () => {
    const { mcp, row, store } = await setup();
    await mcp.reconnect(row);
    await store.update(ANA, row.id, { disabled_tools: ["echo"] });
    assert.ok(!(await mcp.state(ANA)).servers[0]!.tools.some((t) => t.name === "echo"));
    await rejects(mcp.call(ANA, { server: "remote", tool: "echo", args: { text: "x" } }), "host", "mcp_unavailable");
    await store.update(ANA, row.id, { disabled_tools: [], enabled: false });
    assert.deepEqual((await mcp.state(ANA)).servers, []);
    await rejects(mcp.call(ANA, { server: "remote", tool: "boom", args: {} }), "host", "mcp_unavailable");
    assert.equal(mcp.view({ ...row, enabled: false }).status, "off");
  });

  test("another person never reaches it, and unknown servers, tools and big arguments are refused", async () => {
    const { mcp, row } = await setup();
    await mcp.reconnect(row);
    assert.deepEqual((await mcp.state(BEN)).servers, []);
    await rejects(mcp.call(BEN, { server: "remote", tool: "echo", args: { text: "x" } }), "host", "mcp_unavailable");
    await rejects(mcp.call(ANA, { server: "nope", tool: "echo", args: {} }), "host", "mcp_unavailable");
    await rejects(mcp.call(ANA, { server: "remote", tool: "nope", args: {} }), "host", "mcp_unavailable");
    await rejects(mcp.call(ANA, { server: "remote", tool: "echo", args: { text: "x".repeat(100_001) } }), "host", "bad_request");
  });

  test("a slow tool times out and can be cancelled", async () => {
    const { mcp, row } = await setup();
    await mcp.reconnect(row);
    await rejects(mcp.call(ANA, { server: "remote", tool: "slow", args: {} }, { timeoutMs: 200 }), "timeout");
    const c = new AbortController();
    const p = mcp.call(ANA, { server: "remote", tool: "slow", args: {} }, { signal: c.signal });
    setTimeout(() => c.abort(), 100);
    await rejects(p, "cancelled");
  });

  test("an idle connection is closed and opened again on the next use", async () => {
    const { mcp, row, fx } = await setup();
    await mcp.reconnect(row);
    const before = fx.seen.length;
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await mcp.call(ANA, { server: "remote", tool: "echo", args: { text: "again" } }), { text: "echo: again", isError: false, truncated: false });
    assert.ok(fx.seen.length > before);
  });

  test("too many calls in a short time are refused", async () => {
    const { mcp, row } = await setup();
    await mcp.reconnect(row);
    for (let i = 0; i < 120; i++) await mcp.call(ANA, { server: "remote", tool: "echo", args: { text: "x" } });
    await rejects(mcp.call(ANA, { server: "remote", tool: "echo", args: { text: "x" } }), "busy");
  });
});

describe("a header sign-in", () => {
  test("sends the decrypted header; a wrong value is reported as a rejected token without any of the server's words", async () => {
    const { mcp, row, store, fx } = await setup("header");
    await mcp.reconnect(row);
    assert.equal(mcp.view(row).status, "ready");
    assert.ok(fx.seen.every((s) => s.key === "s3cret"));
    // replacing the token with a wrong one is noticed (the connection is rebuilt)
    const bad = (await store.update(ANA, row.id, { secret_enc: encrypt("wrong"), secret_hint: "rong" }))!;
    await mcp.reconnect(bad);
    const v = mcp.view(bad);
    assert.equal(v.status, "failed");
    assert.equal(v.error, "The server rejected the token. Replace it and try again.");
    assert.ok(!JSON.stringify(v).includes("bad key"));
    assert.deepEqual((await mcp.state(ANA)).servers, []);
    // the secret is never in the view
    const good = (await store.update(ANA, row.id, { secret_enc: encrypt("s3cret"), secret_hint: "cret" }))!;
    await mcp.reconnect(good);
    assert.equal(mcp.view(good).status, "ready");
    assert.ok(!JSON.stringify(mcp.view(good)).includes("s3cret"));
    assert.equal(mcp.view(good).secretHint, "cret");
  });
});

describe("what goes wrong is said in fixed sentences", () => {
  test("blocked address, unreachable, not an MCP server", async () => {
    const guarded = createGuardedFetch({ resolve: (_h, cb) => cb(null, [{ address: "10.1.2.3", family: 4 }]) });
    const store = memoryStore();
    const mcp = new RemoteMcp({ store, encrypt, decrypt, serverUrl: null, fetch: guarded });
    managers.push(mcp);
    const row = await store.insert({ user_id: ANA, name: "inside", url: "https://internal.example.com/mcp", auth_kind: "none", header_name: null, secret_enc: null, secret_hint: null });
    await mcp.reconnect(row);
    assert.equal(mcp.view(row).error, "That address is blocked (private or internal network).");
    const closed = await store.insert({ user_id: ANA, name: "closed", url: "http://127.0.0.1:9/mcp", auth_kind: "none", header_name: null, secret_enc: null, secret_hint: null });
    const m2 = new RemoteMcp({ store, encrypt, decrypt, serverUrl: null, fetch: local });
    managers.push(m2);
    await m2.reconnect(closed);
    assert.equal(m2.view(closed).error, "Could not reach the server.");
    assert.equal(reasonOf(new BlockedAddress("address"), "none").error, "That address is blocked (private or internal network).");
    assert.equal(reasonOf(new Error("who knows"), "none").status, "failed");
  });
});

describe("OAuth", () => {
  const signIn = async (ctx: Awaited<ReturnType<typeof setup>>) => {
    const url = await startSignIn(ctx.d, (await ctx.store.get(ANA, ctx.row.id))!); // fresh from the store, as the route does
    assert.ok(url);
    const u = new URL(url!);
    return { state: u.searchParams.get("state")!, u };
  };

  test("needs sign in, then start, redirect back with the code, connected, tokens encrypted", async () => {
    const ctx = await setup("oauth");
    await ctx.mcp.reconnect(ctx.row);
    assert.equal(ctx.mcp.view(ctx.row).status, "needs_sign_in");
    assert.deepEqual((await ctx.mcp.state(ANA)).servers, []);

    const { u, state } = await signIn(ctx);
    assert.equal(u.origin, ctx.fx.origin);
    assert.equal(u.pathname, "/authorize");
    assert.equal(u.searchParams.get("client_id"), "client-1");
    assert.equal(u.searchParams.get("redirect_uri"), "http://127.0.0.1:9/api/mcp/oauth/callback");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.match(state, /^[0-9a-f]{64}$/);
    const stored = ctx.store.rows.get(ctx.row.id)!;
    assert.equal(stored.oauth_state, state);
    assert.ok(Date.parse(stored.oauth_state_expires!) > Date.now());

    const done = await finishSignIn(ctx.d, { state, code: "good-code" });
    assert.equal(done.ok, true);
    const after = ctx.store.rows.get(ctx.row.id)!;
    assert.ok(done.ok && done.row.oauth_enc === after.oauth_enc, "the row handed back already holds the tokens");
    assert.equal(after.oauth_state, null); // single use
    assert.ok(after.oauth_enc?.startsWith("enc:"));
    assert.ok(!after.oauth_enc!.includes("access-1") && !decrypt(after.oauth_enc!).includes("good-code")); // blob is encrypted; the code is never stored
    assert.ok(decrypt(after.oauth_enc!).includes("access-1")); // ...and holds the tokens

    await ctx.mcp.reconnect(after);
    assert.equal(ctx.mcp.view(after).status, "ready");
    assert.equal((await ctx.mcp.call(ANA, { server: "remote", tool: "echo", args: { text: "oauth" } })).text, "echo: oauth");
    assert.ok(!JSON.stringify(ctx.mcp.view(after)).includes("access-1"));
    assert.equal(ctx.fx.registrations, 1);
  });

  test("the state is single use, short lived and tied to one row; wrong or missing codes sign nobody in", async () => {
    const ctx = await setup("oauth");
    const first = await signIn(ctx);
    assert.deepEqual(await finishSignIn(ctx.d, { state: first.state, code: "bad-code" }), { ok: false, reason: "failed" });
    assert.deepEqual(await finishSignIn(ctx.d, { state: first.state, code: "good-code" }), { ok: false, reason: "unknown" }); // used up, even by a failed try

    const second = await signIn(ctx);
    assert.deepEqual(await finishSignIn(ctx.d, { state: second.state, denied: true }), { ok: false, reason: "denied" });
    const third = await signIn(ctx);
    assert.deepEqual(await finishSignIn(ctx.d, { state: third.state }), { ok: false, reason: "denied" });

    const fourth = await signIn(ctx);
    ctx.store.rows.get(ctx.row.id)!.oauth_state_expires = new Date(Date.now() - 1000).toISOString();
    assert.deepEqual(await finishSignIn(ctx.d, { state: fourth.state, code: "good-code" }), { ok: false, reason: "expired" });

    for (const state of ["", "short", "g".repeat(64), "0".repeat(64), "A".repeat(64)]) assert.deepEqual(await finishSignIn(ctx.d, { state, code: "good-code" }), { ok: false, reason: "unknown" });
    assert.ok(STATE_MS === 600_000);
    assert.equal(ctx.store.rows.get(ctx.row.id)!.oauth_enc?.includes("access"), false);
  });

  test("sign out forgets the tokens; without a public address OAuth is unavailable", async () => {
    const ctx = await setup("oauth");
    const { state } = await signIn(ctx);
    await finishSignIn(ctx.d, { state, code: "good-code" });
    assert.ok(ctx.store.rows.get(ctx.row.id)!.oauth_enc);
    await signOut(ctx.d, ctx.store.rows.get(ctx.row.id)!);
    assert.equal(ctx.store.rows.get(ctx.row.id)!.oauth_enc, null);
    const off = await setup("oauth", {}, { serverUrl: null });
    await assert.rejects(startSignIn(off.d, off.row), /not set up/);
    await off.mcp.reconnect(off.row);
    assert.equal(off.mcp.view(off.row).error, "OAuth sign-in is not set up on this chat server.");
  });
});
