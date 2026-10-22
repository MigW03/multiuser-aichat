import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { McpCallResult, McpRemoteServer, Role, SupabaseLink } from "@mc/shared";

// The routes import the database client, which reads the environment when it loads.
process.env.SUPABASE_URL ??= "http://localhost:54399";
process.env.SUPABASE_SECRET_KEY ??= "test";
process.env.KEY_ENCRYPTION_SECRET ??= Buffer.alloc(32, 7).toString("base64");
process.env.APP_URL ??= "http://localhost:5173";

const HOST = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const STRANGER = "44444444-4444-4444-8444-444444444444";
const NO_SUPABASE = "55555555-5555-4555-8555-555555555555";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REF = "abcdefghijklmnopqrst";
const OTHER_REF = "tsrqponmlkjihgfedcba";

type App = import("hono").Hono;
let app: App;
let link: SupabaseLink | null;
let tools: { user: string; tool: string; args: Record<string, unknown> }[];
let answers: Record<string, McpCallResult>;

const roles: Record<string, Role> = { [HOST]: "host", [ADMIN]: "admin", [MEMBER]: "member", [NO_SUPABASE]: "member" };
const ok = (data: unknown): McpCallResult => ({ text: JSON.stringify(data), isError: false, truncated: false });

before(async () => {
  const { Hono } = await import("hono");
  const { createSupabaseRoutes } = await import("./supabase.ts");
  const row = (user: string) => ({ id: `row-${user}`, user_id: user, name: "supabase", url: "https://mcp.supabase.com/mcp?read_only=true", auth_kind: "oauth" as const, header_name: null, secret_enc: null, secret_hint: null, oauth_enc: null, oauth_state: null, oauth_state_expires: null, enabled: true, disabled_tools: [], created_at: "2026-10-22T00:00:00Z" });
  const view = (r: { id: string; name: string; url: string; enabled: boolean }): McpRemoteServer => ({ id: r.id, name: r.name, url: r.url, authKind: "oauth", enabled: r.enabled, status: "ready", tools: [] });
  const { routes } = { routes: createSupabaseRoutes({
    noRateLimits: true,
    oauthAvailable: () => true,
    panel: {
      list: async (u) => (u === NO_SUPABASE ? [] : [row(u)]),
      view,
      call: async (user, req) => {
        tools.push({ user, tool: req.tool, args: req.args });
        return answers[req.tool] ?? ok({});
      },
    },
    links: {
      get: async () => link,
      roleOf: async (u, p) => (p === PROJECT ? (roles[u] ?? null) : null),
      // Like the database function: the role is checked there.
      set: async (u, p, l) => {
        if (p !== PROJECT || !roles[u]) return { error: "not_found" };
        if (roles[u] === "member") return { error: "forbidden" };
        link = { ref: l.ref, name: l.name, region: l.region, linked_by: u, linked_at: "2026-10-22T20:00:00Z" };
        return null;
      },
      remove: async (u, p) => {
        if (p !== PROJECT || !roles[u]) return { error: "not_found" };
        if (roles[u] === "member") return { error: "forbidden" };
        link = null;
        return null;
      },
    },
  }) };
  app = new Hono();
  app.use("/api/projects/*", async (c, next) => {
    c.set("userId" as never, c.req.header("x-user") as never);
    await next();
  });
  app.route("/api/projects", routes.supabase as never);
});

const reset = () => {
  link = null;
  tools = [];
  answers = {};
};
const call = async (user: string, method: string, path: string, body?: unknown) => {
  const res = await app.request(`/api/projects/${PROJECT}/supabase${path}`, { method, headers: { "x-user": user, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const projectsAnswer = () => ({ list_projects: ok({ projects: [{ ref: REF, name: "muti user chat", region: "sa-east-1", status: "ACTIVE_HEALTHY" }] }) });

describe("the state", () => {
  test("a person outside the project gets nothing", async () => {
    reset();
    assert.equal((await call(STRANGER, "GET", "")).status, 404);
    assert.equal((await call(STRANGER, "GET", "/projects")).status, 404);
    assert.equal((await call(STRANGER, "GET", "/data/tables")).status, 404);
  });
  test("not linked: no link, and only the host and admins may link", async () => {
    reset();
    const h = await call(HOST, "GET", "");
    assert.equal(h.status, 200);
    assert.equal(h.json.link, null);
    assert.equal(h.json.canLink, true);
    assert.equal(h.json.mine.state, "ready");
    assert.equal((await call(ADMIN, "GET", "")).json.canLink, true);
    assert.equal((await call(MEMBER, "GET", "")).json.canLink, false);
  });
  test("a person without a Supabase entry sees mine = none", async () => {
    reset();
    assert.equal((await call(NO_SUPABASE, "GET", "")).json.mine.state, "none");
  });
  test("a bad project id is refused", async () => {
    const res = await app.request("/api/projects/not-a-uuid/supabase", { headers: { "x-user": HOST } });
    assert.equal(res.status, 400);
  });
});

describe("linking", () => {
  test("a member can neither list their projects for linking nor link nor unlink", async () => {
    reset();
    answers = projectsAnswer();
    assert.equal((await call(MEMBER, "GET", "/projects")).status, 403);
    assert.equal((await call(MEMBER, "PUT", "", { ref: REF })).status, 403);
    assert.equal(link, null);
    link = { ref: REF, name: "x", region: "", linked_by: HOST, linked_at: "2026-10-22T20:00:00Z" };
    assert.equal((await call(MEMBER, "DELETE", "")).status, 403);
    assert.notEqual(link, null);
    assert.equal(tools.length, 0, "a member never makes Supabase calls for linking");
  });
  test("the host picks a project from their own account; name and region come from Supabase, not the page", async () => {
    reset();
    answers = projectsAnswer();
    const list = await call(HOST, "GET", "/projects");
    assert.equal(list.status, 200);
    assert.equal(list.json.projects[0].ref, REF);
    const put = await call(HOST, "PUT", "", { ref: REF, name: "Evil <b>name</b>", region: "mars" });
    assert.equal(put.status, 200);
    assert.equal(put.json.link.name, "muti user chat");
    assert.equal(put.json.link.region, "sa-east-1");
    assert.equal(link?.linked_by, HOST);
    // The list was fetched with the host's own entry.
    assert.equal(tools.every((t) => t.user === HOST && t.tool === "list_projects"), true);
  });
  test("a project that is not in the person's own account cannot be linked", async () => {
    reset();
    answers = projectsAnswer();
    const res = await call(ADMIN, "PUT", "", { ref: OTHER_REF });
    assert.equal(res.status, 404);
    assert.equal(link, null);
  });
  test("a malformed reference is refused before anything is called", async () => {
    reset();
    for (const ref of ["short", "ABCDEFGHIJKLMNOPQRST", "abcdefghijklmnopqrs1", "abc'; drop table x;--", 5]) assert.equal((await call(HOST, "PUT", "", { ref })).status, 400);
    assert.equal(tools.length, 0);
  });
  test("an admin can unlink; the state follows", async () => {
    reset();
    link = { ref: REF, name: "muti user chat", region: "sa-east-1", linked_by: HOST, linked_at: "2026-10-22T20:00:00Z" };
    const s = await call(MEMBER, "GET", "");
    assert.equal(s.json.link.name, "muti user chat");
    assert.equal((await call(ADMIN, "DELETE", "")).status, 200);
    assert.equal((await call(MEMBER, "GET", "")).json.link, null);
  });
});

describe("reading a linked project", () => {
  const linked = () => {
    reset();
    link = { ref: REF, name: "muti user chat", region: "sa-east-1", linked_by: HOST, linked_at: "2026-10-22T20:00:00Z" };
  };
  test("not linked: nothing is read", async () => {
    reset();
    const r = await call(MEMBER, "GET", "/data/tables");
    assert.equal(r.status, 404);
    assert.equal(r.json.code, "not_linked");
    assert.equal(tools.length, 0);
  });
  test("a member reads through their OWN entry, for the linked reference only", async () => {
    linked();
    answers = { list_tables: ok({ tables: [{ name: "public.chats", rls_enabled: true, rows: 13 }] }) };
    const r = await call(MEMBER, "GET", "/data/tables");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.tables, [{ name: "chats", rls: true, rows: 13 }]);
    assert.deepEqual(tools.map((t) => [t.user, t.tool, t.args.project_id]), [[MEMBER, "list_tables", REF]]);
  });
  test("someone without a Supabase entry gets a clear answer and nothing is read", async () => {
    linked();
    const r = await call(NO_SUPABASE, "GET", "/data/tables");
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "unavailable");
    assert.equal(tools.length, 0);
  });
  test("the page cannot pick a project, a tool or SQL", async () => {
    linked();
    assert.equal((await call(MEMBER, "GET", `/data/tables?project_id=${OTHER_REF}`)).status, 200);
    assert.equal(tools[0]!.args.project_id, REF);
    assert.equal((await call(MEMBER, "GET", "/data/execute_sql")).status, 400);
    assert.equal((await call(MEMBER, "GET", "/data/logs?source=x%27%20or%201=1")).status, 400);
    assert.equal((await call(MEMBER, "GET", "/data/logs?minutes=100000")).status, 400);
    assert.equal((await call(MEMBER, "GET", "/data/logs?source=postgres_logs&minutes=60&errors=1")).status, 200);
    assert.match(String(tools.at(-1)!.args.sql), /^select timestamp, event_message from logs where source = 'postgres_logs'/);
  });
  test("what Supabase returns is cut down: a hostile name stays text, an odd fix link is dropped", async () => {
    linked();
    answers = { get_advisors: ok({ result: { lints: [{ title: "t", level: "WARN", count: 1, remediation: "javascript:alert(1)", findings: [{ detail: "<img src=x onerror=alert(1)>" }] }] } }) };
    const r = await call(MEMBER, "GET", "/data/checks");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.items[0].url, null);
    assert.equal(typeof r.json.data.items[0].detail, "string");
  });
});
