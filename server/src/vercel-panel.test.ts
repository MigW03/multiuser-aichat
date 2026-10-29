import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { McpCallResult } from "@mc/shared";
import { RelayError } from "./folder-relay.ts";
import type { RemoteRow } from "./mcp-remote-store.ts";
import { answerOf, deploymentProjectId, parseBuildLog, parseDeployments, parseDomainConfig, parseDomains, parseEnv, parseErrors, parseLogs, parseOverview, parseTeams, parseProjects, READ_TOOLS, VercelPanel, VercelPanelError } from "./vercel-panel.ts";

const TEAM = "team_i9aKOw3o8vjpcYCLMJowwp0Q";
const PRJ = "prj_zDTfMGC2XAAWBpp2qiN31nW8MKe";
const OTHER_PRJ = "prj_odVtMFKwc31suyyAXcyO9rbU8rma";
const DPL = "dpl_EaMptfdmqZECzUtWV5yL24YGs8WV";

describe("reading answers", () => {
  test("the Vercel server wraps data in result; plain text stays text", () => {
    assert.deepEqual(answerOf(JSON.stringify({ result: { a: 1 } })), { a: 1 });
    assert.deepEqual(answerOf("[1,2]"), [1, 2]);
    assert.equal(answerOf("## Runtime Errors\n\nNo runtime errors found."), "## Runtime Errors\n\nNo runtime errors found.");
  });
  test("teams and projects keep only well-formed ids", () => {
    const teams = parseTeams({ teams: [{ id: TEAM, slug: "migw03s-projects", name: "migw03's projects" }, { id: "x", slug: "bad", name: "n" }, { id: TEAM, slug: "Bad Slug!", name: "n" }] });
    assert.deepEqual(teams, [{ id: TEAM, slug: "migw03s-projects", name: "migw03's projects" }]);
    const projects = parseProjects({ projects: [{ id: PRJ, name: "multiuser-aichat" }, { id: "nope", name: "x" }] }, teams[0]!);
    assert.deepEqual(projects, [{ teamId: TEAM, teamSlug: "migw03s-projects", teamName: "migw03's projects", projectId: PRJ, name: "multiuser-aichat" }]);
  });
});

describe("deployments", () => {
  const answer = {
    deployments: {
      pagination: { count: 1 },
      deployments: [
        {
          id: DPL,
          url: "https://multiuser-aichat-abc.vercel.app/path",
          created: 1791413535082,
          state: "ready",
          target: "production",
          creator: { username: "migw03" },
          meta: { githubCommitRef: "main", githubCommitSha: "10856de947836f7881390cfb8e0891f62a23e558", githubCommitMessage: "Fix the panel\n\nLong body sk-abcdefghijklmnopqrstuvwx here" },
          inspectorUrl: "https://vercel.com/team/prj/abc",
        },
        { id: "not-a-deployment", state: "READY" },
        { id: "dpl_AAAAAAAAAAAAAAAAAAAA", state: "ERROR", target: null, url: "javascript:alert(1)", inspectorUrl: "https://evil.example/x", meta: { githubCommitMessage: "<img src=x onerror=alert(1)>" } },
      ],
    },
  };
  test("state, branch, short sha, first line of the message, host only", () => {
    const [a, b, ...rest] = parseDeployments(answer);
    assert.equal(rest.length, 0);
    assert.deepEqual(a, { id: DPL, state: "READY", target: "production", branch: "main", sha: "10856de", message: "Fix the panel", author: "migw03", createdAt: "2026-10-07T22:52:15.082Z", host: "multiuser-aichat-abc.vercel.app", inspectorUrl: "https://vercel.com/team/prj/abc" });
    assert.equal(b!.target, "preview");
    assert.equal(b!.host, "", "a non-host address is dropped");
    assert.equal(b!.inspectorUrl, null, "only vercel.com pages are linked");
    assert.equal(b!.message, "<img src=x onerror=alert(1)>", "kept as text; the page never renders it as HTML");
  });
  test("a secret-looking string in a commit message is masked", () => {
    const all = JSON.stringify(parseDeployments({ deployments: [{ id: DPL, state: "READY", meta: { githubCommitMessage: "token sk-abcdefghijklmnopqrstuvwx" } }] }));
    assert.doesNotMatch(all, /sk-abcdefghijklmnopqrstuvwx/);
  });
  test("overview: project facts, latest production deployment, a custom domain over the vercel.app one", () => {
    const o = parseOverview({ name: "multiuser-aichat", framework: "vite", nodeVersion: "24.x", link: { org: "MigW03", repo: "multiuser-aichat" }, domains: ["multiuser-aichat.vercel.app", "nido.chat"] }, null);
    assert.deepEqual(o, { name: "multiuser-aichat", framework: "vite", node: "24.x", repo: "MigW03/multiuser-aichat", production: null, domain: "nido.chat" });
  });
});

describe("errors and logs", () => {
  test("Vercel's text answer: none found", () => {
    assert.deepEqual(parseErrors("## Runtime Errors\n\n**Project:** prj_x\n\nNo runtime errors found in the selected time range."), { none: true, lines: [] });
  });
  test("a text answer with errors keeps clean lines", () => {
    const r = parseErrors("## Runtime Errors\n**Project:** prj_x\n- **TypeError** x 23 on `/api/chat`\n- Timeout \u001b[31mred\u001b[0m");
    assert.equal(r.none, false);
    assert.deepEqual(r.lines, ["- TypeError x 23 on /api/chat", "- Timeout red"]);
  });
  test("a JSON answer is written as lines", () => {
    const r = parseErrors({ groups: [{ name: "TypeError: x", count: 3, route: "/api/chat" }] });
    assert.deepEqual(r, { none: false, lines: ["3× TypeError: x · /api/chat"] });
    assert.deepEqual(parseLogs({ logs: [{ level: "error", message: "boom", timestamp: 1791413535082 }] }).lines, ["error boom · 2026-10-07 22:52Z"]);
    assert.deepEqual(parseLogs("No logs found."), { lines: [] });
  });
});

describe("domains", () => {
  test("names must be host names; config says whether DNS is set up", () => {
    const d = parseDomains({ domains: [{ name: "nido.chat", verified: true, redirect: null }, { name: "bad name!", verified: true }, { name: "www.nido.chat", verified: false, redirect: "nido.chat" }] });
    assert.deepEqual(d.map((x) => [x.name, x.verified, x.redirect]), [["nido.chat", true, null], ["www.nido.chat", false, "nido.chat"]]);
    assert.equal(parseDomainConfig({ misconfigured: false }), true);
    assert.equal(parseDomainConfig({ misconfigured: true }), false);
    assert.equal(parseDomainConfig("nope"), null);
  });
});

describe("environment variables: names only", () => {
  const SECRET = "super-secret-value-123";
  const answer = { envs: [
    { id: "e1", key: "VITE_SERVER_URL", value: SECRET, type: "plain", target: ["production"], updatedAt: 1791413535082, decrypted: true },
    { id: "e2", key: "KEY_ENCRYPTION_SECRET", value: "eyJ2YWx1ZSI6IkVOQ1JZUFRFRCJ9", type: "encrypted", target: ["production", "preview"], createdAt: 1791413535082 },
    { id: "e3", key: "bad key with spaces", value: SECRET, target: ["production"] },
    { id: "e4", key: "CUSTOM_ONLY", value: SECRET, type: "sensitive", target: [], customEnvironmentIds: ["env_1"] },
  ] };
  test("no value ever comes out, whatever the answer carries", () => {
    const vars = parseEnv(answer);
    assert.deepEqual(vars.map((v) => v.key), ["CUSTOM_ONLY", "KEY_ENCRYPTION_SECRET", "VITE_SERVER_URL"]);
    const out = JSON.stringify(vars);
    assert.doesNotMatch(out, new RegExp(SECRET));
    assert.doesNotMatch(out, /eyJ2YWx1ZSI6/);
    assert.doesNotMatch(out, /"value"/);
    for (const v of vars) assert.deepEqual(Object.keys(v).sort(), ["key", "targets", "type", "updatedAt"]);
    assert.deepEqual(vars[0]!.targets, ["custom"]);
  });
});

describe("build log", () => {
  test("lines in time order, colour codes removed, secrets masked, errors flagged, only the last 200", () => {
    const events = Array.from({ length: 250 }, (_, i) => ({ created: 1791413535082 + i, type: "stdout", text: `line ${i}` }));
    events.push({ created: 1791413600000, type: "stderr", text: "\u001b[31mError: failed\u001b[0m with sk-abcdefghijklmnopqrstuvwx" });
    const all = parseBuildLog({ events }, false);
    assert.equal(all.length, 200);
    const last = all.at(-1)!;
    assert.equal(last.level, "error");
    assert.doesNotMatch(last.text, /sk-abcdefghijklmnopqrstuvwx|\u001b/);
    assert.deepEqual(parseBuildLog({ events }, true).map((l) => l.level), ["error"]);
  });
});

describe("the deployment's project", () => {
  test("read from get_deployment", () => {
    assert.equal(deploymentProjectId({ deployment: { project: { id: PRJ } } }), PRJ);
    assert.equal(deploymentProjectId({ projectId: PRJ }), PRJ);
    assert.equal(deploymentProjectId("text"), "");
  });
});

const row = (user: string): RemoteRow => ({ id: `row-${user}`, user_id: user, name: "vercel", url: "https://mcp.vercel.com/", auth_kind: "oauth", header_name: null, secret_enc: null, secret_hint: null, oauth_enc: null, oauth_state: null, oauth_state_expires: null, enabled: true, disabled_tools: [], created_at: "2026-10-22T00:00:00Z" });
const ok = (data: unknown): McpCallResult => ({ text: typeof data === "string" ? data : JSON.stringify({ result: data }), isError: false, truncated: false });

describe("the panel", () => {
  const make = (answers: Record<string, McpCallResult | (() => McpCallResult)>) => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const panel = new VercelPanel({
      list: async (u) => [row(u)],
      view: () => ({ id: "x", name: "vercel", url: "", authKind: "oauth", enabled: true, status: "ready", tools: [] }),
      call: async (_u, req) => {
        calls.push({ tool: req.tool, args: req.args });
        const a = answers[req.tool];
        return typeof a === "function" ? a() : (a ?? ok({}));
      },
    });
    return { panel, calls };
  };
  const link = { teamId: TEAM, projectId: PRJ };

  test("only read tools exist for the tab", () => {
    assert.equal(READ_TOOLS.size, 11);
    for (const t of ["create_project_env", "edit_project_env", "create_deployment", "request_promote", "buy_domain", "update_project", "pause_project"]) assert.equal(READ_TOOLS.has(t), false, t);
  });
  test("env is read without asking for decrypted values", async () => {
    const { panel, calls } = make({ filter_project_envs: ok({ envs: [{ key: "A", value: "v", target: ["production"] }] }) });
    const r = await panel.section("u", link, "env");
    assert.deepEqual(r, { vars: [{ key: "A", targets: ["production"], type: "", updatedAt: null }] });
    assert.deepEqual(calls[0], { tool: "filter_project_envs", args: { teamId: TEAM, idOrName: PRJ } });
  });
  test("the build log of a deployment from another project is refused", async () => {
    const { panel, calls } = make({ get_deployment: ok({ deployment: { id: DPL, project: { id: OTHER_PRJ } } }) });
    await assert.rejects(panel.section("u", link, "buildlog", { deployment: DPL }), (e) => e instanceof VercelPanelError && e.code === "no_access");
    assert.deepEqual(calls.map((c) => c.tool), ["get_deployment"], "no log was read");
  });
  test("the build log of a deployment of the linked project is read, last events first asked for", async () => {
    const { panel, calls } = make({ get_deployment: ok({ deployment: { id: DPL, project: { id: PRJ } } }), list_deployment_events: ok({ events: [{ created: 2, type: "stdout", text: "second" }, { created: 1, type: "stdout", text: "first" }] }) });
    const r = await panel.section("u", link, "buildlog", { deployment: DPL });
    assert.deepEqual(r.lines.map((l) => l.text), ["first", "second"]);
    assert.equal(calls[1]!.args.direction, "backward");
    await assert.rejects(panel.section("u", link, "buildlog", { deployment: "dpl_x; rm -rf" }), VercelPanelError);
  });
  test("a plan that keeps logs for one hour: a clear answer", async () => {
    const { panel } = make({ get_runtime_logs: { text: "Runtime log query failed: The hobby plan does not retain runtime logs for the requested time range.", isError: true, truncated: false } });
    await assert.rejects(panel.section("u", link, "logs", { minutes: 1440 }), (e) => e instanceof VercelPanelError && e.code === "window");
  });
  test("no access and sign-in problems are told apart; the server's words are not passed on", async () => {
    const a = make({ get_project: { text: "Vercel API request failed (404: not_found). Project not found. <script>alert(1)</script>", isError: true, truncated: false } });
    await assert.rejects(a.panel.section("u", link, "overview"), (e) => e instanceof VercelPanelError && e.code === "no_access" && !/script/.test(e.message));
    const b = new VercelPanel({ list: async (u) => [row(u)], view: () => ({}) as never, call: async () => { throw new RelayError("host", "Sign in needed", "mcp_failed"); } });
    await assert.rejects(b.section("u", link, "domains"), (e) => e instanceof VercelPanelError && e.code === "needs_sign_in");
  });
  test("domains: DNS check per domain", async () => {
    const { panel, calls } = make({ list_project_domains: ok({ domains: [{ name: "nido.chat", verified: true }] }), get_domain_config: ok({ misconfigured: true }) });
    const r = await panel.section("u", link, "domains");
    assert.deepEqual(r.domains, [{ name: "nido.chat", verified: true, redirect: null, configured: false }]);
    assert.deepEqual(calls.map((c) => c.tool), ["list_project_domains", "get_domain_config"]);
  });
  test("a person without a Vercel entry reads nothing", async () => {
    const calls: string[] = [];
    const panel = new VercelPanel({ list: async () => [], view: () => ({}) as never, call: async (_u, r) => (calls.push(r.tool), ok({})) });
    await assert.rejects(panel.section("u", link, "overview"), (e) => e instanceof VercelPanelError && e.code === "unavailable");
    assert.equal(calls.length, 0);
  });
});
