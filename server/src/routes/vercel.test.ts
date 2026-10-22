import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { McpCallResult, McpRemoteServer, Role, VercelLink } from "@mc/shared";

// The routes import the database client, which reads the environment when it loads.
process.env.SUPABASE_URL ??= "http://localhost:54399";
process.env.SUPABASE_SECRET_KEY ??= "test";
process.env.KEY_ENCRYPTION_SECRET ??= Buffer.alloc(32, 7).toString("base64");
process.env.APP_URL ??= "http://localhost:5173";

const HOST = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const STRANGER = "44444444-4444-4444-8444-444444444444";
const NO_VERCEL = "55555555-5555-4555-8555-555555555555";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM = "team_i9aKOw3o8vjpcYCLMJowwp0Q";
const PRJ = "prj_zDTfMGC2XAAWBpp2qiN31nW8MKe";
const OTHER_PRJ = "prj_odVtMFKwc31suyyAXcyO9rbU8rma";
const OTHER_TEAM = "team_ZZZZZZZZZZZZZZZZZZZZZZZZ";
const DPL = "dpl_EaMptfdmqZECzUtWV5yL24YGs8WV";

type App = import("hono").Hono;
let app: App;
let link: VercelLink | null;
let tools: { user: string; tool: string; args: Record<string, unknown> }[];
let answers: Record<string, McpCallResult>;

const roles: Record<string, Role> = { [HOST]: "host", [ADMIN]: "admin", [MEMBER]: "member", [NO_VERCEL]: "member" };
const ok = (data: unknown): McpCallResult => ({ text: JSON.stringify({ result: data }), isError: false, truncated: false });

before(async () => {
  const { Hono } = await import("hono");
  const { createVercelRoutes } = await import("./vercel.ts");
  const row = (user: string) => ({ id: `row-${user}`, user_id: user, name: "vercel", url: "https://mcp.vercel.com/", auth_kind: "oauth" as const, header_name: null, secret_enc: null, secret_hint: null, oauth_enc: null, oauth_state: null, oauth_state_expires: null, enabled: true, disabled_tools: [], created_at: "2026-10-22T00:00:00Z" });
  const view = (r: { id: string; name: string; url: string; enabled: boolean }): McpRemoteServer => ({ id: r.id, name: r.name, url: r.url, authKind: "oauth", enabled: r.enabled, status: "ready", tools: [] });
  const { vercel } = createVercelRoutes({
    noRateLimits: true,
    oauthAvailable: () => true,
    panel: {
      list: async (u) => (u === NO_VERCEL ? [] : [row(u)]),
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
        link = { ...l, linked_by: u, linked_at: "2026-10-22T20:00:00Z" };
        return null;
      },
      remove: async (u, p) => {
        if (p !== PROJECT || !roles[u]) return { error: "not_found" };
        if (roles[u] === "member") return { error: "forbidden" };
        link = null;
        return null;
      },
    },
  });
  app = new Hono();
  app.use("/api/projects/*", async (c, next) => {
    c.set("userId" as never, c.req.header("x-user") as never);
    await next();
  });
  app.route("/api/projects", vercel as never);
});

const reset = () => {
  link = null;
  tools = [];
  answers = {};
};
const call = async (user: string, method: string, path: string, body?: unknown) => {
  const res = await app.request(`/api/projects/${PROJECT}/vercel${path}`, { method, headers: { "x-user": user, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const projectsAnswers = () => ({ list_teams: ok({ teams: [{ id: TEAM, slug: "migw03s-projects", name: "migw03's projects" }] }), list_projects: ok({ projects: [{ id: PRJ, name: "multiuser-aichat" }] }) });
const linked = () => {
  reset();
  link = { teamId: TEAM, teamSlug: "migw03s-projects", projectId: PRJ, name: "multiuser-aichat", linked_by: HOST, linked_at: "2026-10-22T20:00:00Z" };
};

describe("the state", () => {
  test("a person outside the project gets nothing", async () => {
    reset();
    assert.equal((await call(STRANGER, "GET", "")).status, 404);
    assert.equal((await call(STRANGER, "GET", "/projects")).status, 404);
    assert.equal((await call(STRANGER, "GET", "/data/deployments")).status, 404);
    assert.equal(tools.length, 0);
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
  test("a person without a Vercel entry sees mine = none", async () => {
    reset();
    assert.equal((await call(NO_VERCEL, "GET", "")).json.mine.state, "none");
  });
  test("a bad project id is refused", async () => {
    const res = await app.request("/api/projects/not-a-uuid/vercel", { headers: { "x-user": HOST } });
    assert.equal(res.status, 400);
  });
});

describe("linking", () => {
  test("a member can neither list their projects for linking nor link nor unlink", async () => {
    reset();
    answers = projectsAnswers();
    assert.equal((await call(MEMBER, "GET", "/projects")).status, 403);
    assert.equal((await call(MEMBER, "PUT", "", { teamId: TEAM, projectId: PRJ })).status, 403);
    assert.equal(link, null);
    linked();
    assert.equal((await call(MEMBER, "DELETE", "")).status, 403);
    assert.notEqual(link, null);
    assert.equal(tools.length, 0, "a member never makes Vercel calls for linking");
  });
  test("the host picks a project from their own account; name and team come from Vercel, not the page", async () => {
    reset();
    answers = projectsAnswers();
    const list = await call(HOST, "GET", "/projects");
    assert.equal(list.status, 200);
    assert.equal(list.json.projects[0].projectId, PRJ);
    const put = await call(HOST, "PUT", "", { teamId: TEAM, projectId: PRJ, name: "Evil <b>name</b>", teamSlug: "evil" });
    assert.equal(put.status, 200);
    assert.equal(put.json.link.name, "multiuser-aichat");
    assert.equal(put.json.link.teamSlug, "migw03s-projects");
    assert.equal(link?.linked_by, HOST);
    assert.equal(tools.every((t) => t.user === HOST && ["list_teams", "list_projects"].includes(t.tool)), true, "the host's own entry, list tools only");
  });
  test("a project that is not in the person's own account cannot be linked", async () => {
    reset();
    answers = projectsAnswers();
    assert.equal((await call(ADMIN, "PUT", "", { teamId: TEAM, projectId: OTHER_PRJ })).status, 404);
    assert.equal((await call(ADMIN, "PUT", "", { teamId: OTHER_TEAM, projectId: PRJ })).status, 404, "right project, wrong team");
    assert.equal(link, null);
  });
  test("malformed ids are refused before anything is called", async () => {
    reset();
    for (const body of [{ teamId: "x", projectId: PRJ }, { teamId: TEAM, projectId: "prj_" }, { teamId: TEAM, projectId: `${PRJ}'; drop table x;--` }, { teamId: 5, projectId: PRJ }, {}]) assert.equal((await call(HOST, "PUT", "", body)).status, 400);
    assert.equal(tools.length, 0);
  });
  test("an admin can unlink; the state follows", async () => {
    linked();
    assert.equal((await call(MEMBER, "GET", "")).json.link.name, "multiuser-aichat");
    assert.equal((await call(ADMIN, "DELETE", "")).status, 200);
    assert.equal((await call(MEMBER, "GET", "")).json.link, null);
  });
});

describe("reading a linked project", () => {
  test("not linked: nothing is read", async () => {
    reset();
    const r = await call(MEMBER, "GET", "/data/deployments");
    assert.equal(r.status, 404);
    assert.equal(r.json.code, "not_linked");
    assert.equal(tools.length, 0);
  });
  test("a member reads through their OWN entry, for the linked team and project only", async () => {
    linked();
    answers = { list_deployments: ok({ deployments: { deployments: [{ id: DPL, state: "READY", target: "production" }] } }) };
    const r = await call(MEMBER, "GET", "/data/deployments");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.deployments[0].id, DPL);
    assert.deepEqual(tools.map((t) => [t.user, t.tool, t.args.teamId, t.args.projectId]), [[MEMBER, "list_deployments", TEAM, PRJ]]);
  });
  test("someone without a Vercel entry gets a clear answer and nothing is read", async () => {
    linked();
    const r = await call(NO_VERCEL, "GET", "/data/deployments");
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "unavailable");
    assert.equal(tools.length, 0);
  });
  test("the page cannot pick a project, a team, a tool or a window", async () => {
    linked();
    assert.equal((await call(MEMBER, "GET", `/data/deployments?projectId=${OTHER_PRJ}&teamId=${OTHER_TEAM}`)).status, 200);
    assert.equal(tools[0]!.args.projectId, PRJ);
    assert.equal(tools[0]!.args.teamId, TEAM);
    assert.equal((await call(MEMBER, "GET", "/data/create_project_env")).status, 400);
    assert.equal((await call(MEMBER, "GET", "/data/logs?minutes=100000")).status, 400);
    assert.equal((await call(MEMBER, "GET", "/data/errors?since=90d")).status, 400);
    assert.equal((await call(MEMBER, "GET", "/data/buildlog?deployment=x")).status, 400);
    assert.equal((await call(MEMBER, "GET", "/data/buildlog")).status, 502, "a build log needs a deployment");
  });
  test("env: names only, never a value, and no decrypt asked for", async () => {
    linked();
    answers = { filter_project_envs: ok({ envs: [{ key: "VITE_SERVER_URL", value: "https://secret.example", type: "plain", target: ["production"] }] }) };
    const r = await call(MEMBER, "GET", "/data/env");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.vars.map((v: { key: string }) => v.key), ["VITE_SERVER_URL"]);
    assert.doesNotMatch(JSON.stringify(r.json), /secret\.example|"value"/);
    assert.equal("decrypt" in tools[0]!.args, false);
  });
  test("a build log of another project's deployment is refused", async () => {
    linked();
    answers = { get_deployment: ok({ deployment: { id: DPL, project: { id: OTHER_PRJ } } }) };
    const r = await call(MEMBER, "GET", `/data/buildlog?deployment=${DPL}`);
    assert.equal(r.status, 403);
    assert.deepEqual(tools.map((t) => t.tool), ["get_deployment"]);
  });
  test("what Vercel returns is cut down: a hostile commit message stays text, an odd inspector link is dropped", async () => {
    linked();
    answers = { list_deployments: ok({ deployments: { deployments: [{ id: DPL, state: "READY", meta: { githubCommitMessage: "<img src=x onerror=alert(1)>" }, inspectorUrl: "javascript:alert(1)" }] } }) };
    const r = await call(MEMBER, "GET", "/data/deployments");
    assert.equal(r.json.data.deployments[0].inspectorUrl, null);
    assert.equal(typeof r.json.data.deployments[0].message, "string");
  });
  test("a plan that keeps logs for an hour: a short, clear answer", async () => {
    linked();
    answers = { get_runtime_logs: { text: "The hobby plan does not retain runtime logs for the requested time range.", isError: true, truncated: false } };
    const r = await call(MEMBER, "GET", "/data/logs?minutes=1440");
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "window");
  });
});
