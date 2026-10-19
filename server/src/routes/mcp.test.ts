import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

// The routes import the database client and the key encryption, which read the environment when they load.
process.env.SUPABASE_URL ??= "http://localhost:54399";
process.env.SUPABASE_SECRET_KEY ??= "test";
process.env.KEY_ENCRYPTION_SECRET ??= Buffer.alloc(32, 7).toString("base64");
process.env.APP_URL ??= "http://localhost:5173";

const ANA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";

type App = import("hono").Hono;
let app: App;
let store: ReturnType<typeof import("../test-fixtures/memory-store.ts").memoryStore>;
let remote: import("../mcp-remote.ts").RemoteMcp;
let decrypt: (s: string) => string;

before(async () => {
  const { Hono } = await import("hono");
  const { memoryStore } = await import("../test-fixtures/memory-store.ts");
  const real = await import("../crypto.ts"); // the routes use the real encryption: what is stored must decrypt with it
  const { encrypt } = real;
  decrypt = real.decrypt;
  const { RemoteMcp } = await import("../mcp-remote.ts");
  const { createGuardedFetch } = await import("../ssrf.ts");
  const { createMcpRoutes } = await import("./mcp.ts");
  store = memoryStore();
  // Names resolve to a private address, so nothing here ever connects anywhere.
  const fetch = createGuardedFetch({ resolve: (_h, cb) => cb(null, [{ address: "10.0.0.1", family: 4 }]) });
  const oauth = { store, encrypt, decrypt: real.decrypt, serverUrl: "https://chat.example.com", fetch };
  remote = new RemoteMcp(oauth);
  const { mcpServers, mcpOauthPublic } = createMcpRoutes({ store, remoteMcp: remote, oauth, noRateLimits: true });
  app = new Hono();
  app.use("/api/mcp/servers/*", async (c, next) => {
    c.set("userId" as never, c.req.header("x-user") as never);
    await next();
  });
  app.use("/api/mcp/servers", async (c, next) => {
    c.set("userId" as never, c.req.header("x-user") as never);
    await next();
  });
  app.route("/api/mcp", mcpServers as never);
  app.route("/api/mcp/oauth", mcpOauthPublic);
});

const call = async (user: string, method: string, path: string, body?: unknown) => {
  const res = await app.request(`/api/mcp${path}`, { method, headers: { "x-user": user, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const add = (user: string, name: string, url: string, auth: unknown = { kind: "none" }) => call(user, "POST", "/servers", { name, url, auth });

describe("adding", () => {
  test("a server of each kind; the secret is encrypted in the store and never in an answer", async () => {
    const a = await add(ANA, "plain", "https://mcp.example.com/mcp");
    assert.equal(a.status, 201);
    assert.equal(a.json.authKind, "none");
    const h = await add(ANA, "keyed", "https://mcp.example.com/mcp", { kind: "header", name: "Authorization", value: "Bearer super-secret-token-4f2a" });
    assert.equal(h.status, 201);
    assert.equal(h.json.headerName, "Authorization");
    assert.equal(h.json.secretHint, "4f2a");
    const o = await add(ANA, "signed", "https://mcp.example.com/mcp", { kind: "oauth" });
    assert.equal(o.status, 201);
    const row = [...store.rows.values()].find((r) => r.name === "keyed")!;
    assert.ok(row.secret_enc && !row.secret_enc.includes("super-secret") && decrypt(row.secret_enc) === "Bearer super-secret-token-4f2a");
    const list = await call(ANA, "GET", "/servers");
    assert.equal(list.json.servers.length, 3);
    assert.equal(list.json.oauthAvailable, true);
    assert.ok(!JSON.stringify(list.json).includes("super-secret"), "no secret in the list");
    assert.ok(!JSON.stringify(list.json).includes("secret_enc"));
  });

  test("bad names, addresses and headers are refused with a plain message", async () => {
    const bad = async (name: string, url: string, auth: unknown, text: RegExp) => {
      const r = await add(BEN, name, url, auth);
      assert.equal(r.status, 400, `${name} ${url}`);
      assert.match(String(r.json.error), text);
    };
    await bad("bad name", "https://mcp.example.com/mcp", { kind: "none" }, /name is 1 to 32/);
    await bad("ok", "http://mcp.example.com/mcp", { kind: "none" }, /https/);
    await bad("ok", "https://localhost/mcp", { kind: "none" }, /blocked/);
    await bad("ok", "https://169.254.169.254/latest", { kind: "none" }, /blocked/);
    await bad("ok", "https://10.0.0.5/mcp", { kind: "none" }, /blocked/);
    await bad("ok", "https://user:pw@mcp.example.com/mcp", { kind: "none" }, /user name or password/);
    await bad("ok", "not a url", { kind: "none" }, /valid address/);
    await bad("ok", "https://mcp.example.com/mcp", { kind: "header", name: "Host", value: "x" }, /can't be set/);
    await bad("ok", "https://mcp.example.com/mcp", { kind: "header", name: "Content-Type", value: "x" }, /can't be set/);
    await bad("ok", "https://mcp.example.com/mcp", { kind: "header", name: "Bad Name", value: "x" }, /letters, digits/);
    await bad("ok", "https://mcp.example.com/mcp", { kind: "header", name: "X-Key", value: "a\r\nX-Evil: 1" }, /line breaks/);
    await bad("ok", "https://mcp.example.com/mcp", { kind: "header", name: "X-Key", value: "" }, /./);
    await bad("ok", "https://mcp.example.com/mcp", { kind: "weird" }, /./);
    assert.equal((await call(BEN, "GET", "/servers")).json.servers.length, 0, "nothing was saved");
  });

  test("a name can be used once per person, at most 10 servers, another person is unaffected", async () => {
    assert.equal((await add(ANA, "plain", "https://mcp.example.com/mcp")).status, 400);
    assert.match(String((await add(ANA, "plain", "https://mcp.example.com/mcp")).json.error), /already have a server/);
    for (let i = 0; i < 7; i++) assert.equal((await add(ANA, `s${i}`, "https://mcp.example.com/mcp")).status, 201);
    const eleventh = await add(ANA, "eleventh", "https://mcp.example.com/mcp");
    assert.equal(eleventh.status, 400);
    assert.match(String(eleventh.json.error), /up to 10/);
    assert.equal((await add(BEN, "plain", "https://mcp.example.com/mcp")).status, 201);
  });
});

describe("one person's servers are theirs alone", () => {
  test("another person gets 404 for every action on them, and does not see them", async () => {
    const mine = (await call(ANA, "GET", "/servers")).json.servers.find((s: any) => s.name === "keyed");
    const ben = (await call(BEN, "GET", "/servers")).json.servers;
    assert.ok(!ben.some((s: any) => s.id === mine.id));
    for (const [method, path, body] of [
      ["PATCH", `/servers/${mine.id}`, { enabled: false }],
      ["PUT", `/servers/${mine.id}/token`, { value: "stolen" }],
      ["DELETE", `/servers/${mine.id}`, undefined],
      ["POST", `/servers/${mine.id}/retry`, undefined],
      ["POST", `/servers/${mine.id}/oauth/start`, undefined],
      ["POST", `/servers/${mine.id}/signout`, undefined],
    ] as const) assert.equal((await call(BEN, method, path, body)).status, 404, `${method} ${path}`);
    const row = [...store.rows.values()].find((r) => r.id === mine.id)!;
    assert.equal(row.enabled, true);
    assert.ok(row.secret_enc && !decrypt(row.secret_enc).includes("stolen"));
  });
});

describe("changing", () => {
  test("switch a server and a tool, replace a header value, sign in is only for OAuth servers, delete", async () => {
    const list = (await call(ANA, "GET", "/servers")).json.servers;
    const plain = list.find((s: any) => s.name === "plain");
    const keyed = list.find((s: any) => s.name === "keyed");
    const off = await call(ANA, "PATCH", `/servers/${plain.id}`, { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.json.status, "off");
    await call(ANA, "PATCH", `/servers/${plain.id}`, { tool: { name: "echo", enabled: false } });
    assert.deepEqual([...store.rows.values()].find((r) => r.id === plain.id)!.disabled_tools, ["echo"]);
    await call(ANA, "PATCH", `/servers/${plain.id}`, { tool: { name: "echo", enabled: true } });
    assert.deepEqual([...store.rows.values()].find((r) => r.id === plain.id)!.disabled_tools, []);
    assert.equal((await call(ANA, "PATCH", `/servers/${plain.id}`, { tool: { name: "", enabled: true } })).status, 400);

    const replaced = await call(ANA, "PUT", `/servers/${keyed.id}/token`, { value: "Bearer brand-new-9999" });
    assert.equal(replaced.json.secretHint, "9999");
    assert.ok(!JSON.stringify(replaced.json).includes("brand-new"));
    assert.equal((await call(ANA, "PUT", `/servers/${plain.id}/token`, { value: "x" })).status, 400); // no header sign-in on this server
    assert.equal((await call(ANA, "PUT", `/servers/${keyed.id}/token`, { value: "a\nb" })).status, 400);
    assert.equal((await call(ANA, "POST", `/servers/${keyed.id}/oauth/start`)).status, 400);

    assert.equal((await call(ANA, "POST", `/servers/${keyed.id}/retry`)).status, 200);
    assert.equal((await call(ANA, "DELETE", `/servers/${plain.id}`)).status, 200);
    assert.equal((await call(ANA, "DELETE", `/servers/${plain.id}`)).status, 404);
    assert.ok(![...store.rows.values()].some((r) => r.id === plain.id));
  });
});

describe("the provider's redirect", () => {
  test("an unknown, malformed or reused state gets a plain page that repeats nothing from the request", async () => {
    for (const q of ["", "?state=nope", `?state=${"0".repeat(64)}&code=abc`, `?state=${"0".repeat(64)}&error=access_denied`, `?state=<script>alert(1)</script>&code=<b>x</b>`]) {
      const res = await app.request(`/api/mcp/oauth/callback${q}`);
      const html = await res.text();
      assert.equal(res.status, 400);
      assert.match(html, /Not signed in/);
      assert.ok(!html.includes("<script>alert") && !html.includes("<b>x</b>") && !html.includes("abc"));
    }
  });
});
