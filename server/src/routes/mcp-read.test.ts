import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { PANEL_LIMITS } from "@mc/shared";

// The routes import the database client and the key encryption, which read the environment when they load.
process.env.SUPABASE_URL ??= "http://localhost:54399";
process.env.SUPABASE_SECRET_KEY ??= "test";
process.env.KEY_ENCRYPTION_SECRET ??= Buffer.alloc(32, 7).toString("base64");
process.env.APP_URL ??= "http://localhost:5173";

const ANA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";

type Fixture = import("../test-fixtures/http-mcp-server.ts").Fixture;
let app: import("hono").Hono;
let remote: import("../mcp-remote.ts").RemoteMcp;
let store: ReturnType<typeof import("../test-fixtures/memory-store.ts").memoryStore>;
const fixtures: Fixture[] = [];

before(async () => {
  const { Hono } = await import("hono");
  const { decrypt, encrypt, memoryStore } = await import("../test-fixtures/memory-store.ts");
  const { RemoteMcp } = await import("../mcp-remote.ts");
  const { createGuardedFetch } = await import("../ssrf.ts");
  const { createMcpRoutes } = await import("./mcp.ts");
  const { startFixture } = await import("../test-fixtures/http-mcp-server.ts");
  store = memoryStore();
  const fetch = createGuardedFetch({ allowPrivate: true });
  const oauth = { store, encrypt, decrypt, serverUrl: "http://127.0.0.1:9", fetch, allowInsecureAuthUrl: true };
  remote = new RemoteMcp(oauth);
  const open = await startFixture({ reads: true });
  const keyed = await startFixture({ reads: true, auth: "header" });
  const signed = await startFixture({ reads: true, auth: "oauth" });
  fixtures.push(open, keyed, signed);
  await store.insert({ user_id: ANA, name: "open", url: open.url, auth_kind: "none", header_name: null, secret_enc: null, secret_hint: null });
  await store.insert({ user_id: ANA, name: "keyed", url: keyed.url, auth_kind: "header", header_name: "X-Api-Key", secret_enc: encrypt("wrong"), secret_hint: "rong" });
  await store.insert({ user_id: ANA, name: "signed", url: signed.url, auth_kind: "oauth", header_name: null, secret_enc: null, secret_hint: null });
  const off = await store.insert({ user_id: ANA, name: "off", url: open.url, auth_kind: "none", header_name: null, secret_enc: null, secret_hint: null });
  await store.update(ANA, off.id, { enabled: false });
  const { mcpServers } = createMcpRoutes({ store, remoteMcp: remote, oauth, noRateLimits: true, allowPrivateAddresses: true });
  app = new Hono();
  app.use("/api/mcp/*", async (c, next) => {
    c.set("userId" as never, c.req.header("x-user") as never);
    await next();
  });
  app.route("/api/mcp", mcpServers as never);
});
after(async () => {
  await remote.closeAll();
  await Promise.all(fixtures.map((f) => f.close()));
});

const read = async (user: string, body: unknown) => {
  const res = await app.request("/api/mcp/read", { method: "POST", headers: { "x-user": user, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};

describe("a panel reads one of the person's remote servers", () => {
  test("gets the text, with the fixed arguments", async () => {
    const r = await read(ANA, { server: "open", tool: "list_items", args: { state: "open" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.deepEqual(JSON.parse(r.json.text), { state: "open", items: [{ title: "a" }, { title: "b" }, { title: "c" }] });
    assert.equal(r.json.truncated, false);
  });

  test("a long answer is cut and says so", async () => {
    const r = await read(ANA, { server: "open", tool: "list_big", args: {} });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.truncated, true);
    assert.equal(r.json.text.length, PANEL_LIMITS.resultChars);
  });

  test("a tool that reports an error, or that the server doesn't have, is a calm need", async () => {
    assert.deepEqual((await read(ANA, { server: "open", tool: "list_broken" })).json, { ok: false, need: "retry", server: "open" });
    assert.deepEqual((await read(ANA, { server: "open", tool: "list_missing" })).json, { ok: false, need: "unavailable", server: "open" });
  });

  test("not added, switched off, or somebody else's: set up", async () => {
    assert.deepEqual((await read(ANA, { server: "nope", tool: "list_items" })).json, { ok: false, need: "setup", server: "nope" });
    assert.deepEqual((await read(ANA, { server: "off", tool: "list_items" })).json, { ok: false, need: "setup", server: "off" });
    assert.deepEqual((await read(BEN, { server: "open", tool: "list_items" })).json, { ok: false, need: "setup", server: "open" });
  });

  test("a wrong key or a missing OAuth sign-in asks the person to sign in, in words that carry nothing from the server", async () => {
    const keyed = await read(ANA, { server: "keyed", tool: "list_items" });
    assert.deepEqual(keyed.json, { ok: false, need: "signin", server: "keyed" });
    const signed = await read(ANA, { server: "signed", tool: "list_items" });
    assert.deepEqual(signed.json, { ok: false, need: "signin", server: "signed" });
  });

  test("only reads: anything else, bad names and oversized arguments are refused before any call", async () => {
    for (const tool of ["echo", "delete_item", "execute_sql", "create_issue", "list_x; drop", "", "a".repeat(65)]) assert.equal((await read(ANA, { server: "open", tool })).status, 400, tool);
    assert.equal((await read(ANA, { server: "bad name", tool: "list_items" })).status, 400);
    assert.equal((await read(ANA, { server: "open", tool: "list_items", args: { x: "y".repeat(PANEL_LIMITS.argChars) } })).status, 400);
    assert.equal((await read(ANA, { server: "open", tool: "list_items", args: [1] })).status, 400);
    assert.equal((await read(ANA, null)).status, 400);
  });
});
