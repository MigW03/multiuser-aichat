import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { McpCallResult, McpRemoteServer } from "@mc/shared";
import { RelayError } from "./folder-relay.ts";
import type { RemoteRow } from "./mcp-remote-store.ts";
import { byLevel, findPublishableKey, logsSql, mineOf, PanelError, parseAnswer, parseChecks, parseConnect, parseFunctions, parseLogs, parseMigrations, parseOverview, parseProjects, parseTables, parseUsers, READ_TOOLS, USERS_SQL, SupabasePanel, supabaseRowOf } from "./supabase-panel.ts";

const REF = "abcdefghijklmnopqrst";
const row = (over: Partial<RemoteRow> = {}): RemoteRow => ({
  id: "r1", user_id: "u1", name: "supabase", url: "https://mcp.supabase.com/mcp?read_only=true", auth_kind: "oauth", header_name: null, secret_enc: null, secret_hint: null, oauth_enc: null, oauth_state: null, oauth_state_expires: null, enabled: true, disabled_tools: [], created_at: "2026-10-22T00:00:00Z", ...over,
});
const view = (status: McpRemoteServer["status"], error?: string) => (r: RemoteRow): McpRemoteServer => ({ id: r.id, name: r.name, url: r.url, authKind: "oauth", enabled: r.enabled, status, ...(error ? { error } : {}), tools: [] });
const ok = (data: unknown, wrapped = false): McpCallResult => ({ text: wrapped ? `Below is the result.\n<untrusted-data-1234-abcd>\n${JSON.stringify(data)}\n</untrusted-data-1234-abcd>\nUse this data.` : JSON.stringify(data), isError: false, truncated: false });

describe("which entry is Supabase", () => {
  test("by address host only", () => {
    assert.equal(supabaseRowOf([row({ url: "https://mcp.example.com/mcp" })]), null);
    assert.equal(supabaseRowOf([row({ url: "https://mcp.supabase.com.evil.example/mcp" })]), null);
    assert.equal(supabaseRowOf([row({ url: "http://mcp.supabase.com/mcp" })]), null);
    assert.equal(supabaseRowOf([row({ url: "https://mcp.supabase.com/mcp?project_ref=x" })])?.id, "r1");
  });
  test("an enabled entry wins over a disabled one", () => {
    assert.equal(supabaseRowOf([row({ id: "a", enabled: false }), row({ id: "b" })])?.id, "b");
    assert.equal(supabaseRowOf([row({ id: "a", enabled: false })])?.id, "a");
  });
  test("the person's own state", () => {
    assert.deepEqual(mineOf(null, view("ready")), { state: "none" });
    assert.deepEqual(mineOf(row({ enabled: false }), view("ready")), { state: "off", serverId: "r1" });
    assert.deepEqual(mineOf(row(), view("ready")), { state: "ready", serverId: "r1" });
    assert.deepEqual(mineOf(row(), view("needs_sign_in", "Sign in needed.")), { state: "needs_sign_in", serverId: "r1", error: "Sign in needed." });
  });
});

describe("reading answers", () => {
  test("plain JSON and JSON inside the untrusted-data markers", () => {
    assert.deepEqual(parseAnswer('{"a":1}'), { a: 1 });
    assert.deepEqual(parseAnswer(`Below is text.\n<untrusted-data-9f-1>\n[{"a":1}]\n</untrusted-data-9f-1>\nUse it.`), [{ a: 1 }]);
  });
  test("text that is not JSON is a failure, not a crash", () => {
    assert.throws(() => parseAnswer("not json at all"), (e) => e instanceof PanelError && e.code === "failed");
    assert.throws(() => parseAnswer("{broken"), (e) => e instanceof PanelError);
  });
  test("projects: only valid references, names cut", () => {
    const list = parseProjects({ projects: [{ ref: REF, name: "muti user chat", region: "sa-east-1", status: "ACTIVE_HEALTHY" }, { ref: "BAD", name: "x" }, { id: "short" }, "junk", { ref: REF.replace("a", "b"), name: "\u0007bell\nname", region: "Not Valid!" }] });
    assert.equal(list.length, 2);
    assert.deepEqual(list[0], { ref: REF, name: "muti user chat", region: "sa-east-1", status: "ACTIVE_HEALTHY" });
    assert.equal(list[1]!.name, "bell name");
    assert.equal(list[1]!.region, "");
  });
  test("overview: version cut to two parts, counts optional", () => {
    const o = parseOverview({ name: "muti user chat", region: "sa-east-1", status: "ACTIVE_HEALTHY", database: { version: "17.11.0.003" } }, [{ db_bytes: "13631488", auth_users: 6, policies: 17, tables: 18, migrations: 20 }]);
    assert.deepEqual(o, { name: "muti user chat", region: "sa-east-1", status: "ACTIVE_HEALTHY", postgres: "17.11", dbBytes: 13631488, authUsers: 6, policies: 17, tables: 18, migrations: 20 });
    const bare = parseOverview({ name: "x" }, []);
    assert.equal(bare.dbBytes, null);
    assert.equal(bare.postgres, "");
  });
  test("checks: sorted by level, backticks removed, only supabase.com guides become links", () => {
    const data = { result: { lints: [
      { title: "Unused Index", level: "INFO", count: 2, remediation: "https://supabase.com/docs/guides/database/database-linter?lint=0005", findings: [{ detail: "Index `x` has not been used" }] },
      { title: "Leaked password", level: "WARN", count: 1, remediation: "https://evil.example/phish", findings: [{ detail: "off" }] },
      { title: "Weird", level: "SEVERE", description: "d", count: "x", remediation: "javascript:alert(1)" },
    ] } };
    const items = parseChecks(data, "security").sort(byLevel);
    assert.deepEqual(items.map((i) => i.level), ["WARN", "INFO", "INFO"]);
    assert.equal(items.find((i) => i.title === "Leaked password")!.url, null);
    assert.equal(items.find((i) => i.title === "Weird")!.url, null);
    assert.equal(items.find((i) => i.title === "Unused Index")!.url, "https://supabase.com/docs/guides/database/database-linter?lint=0005");
    assert.equal(items.find((i) => i.title === "Unused Index")!.detail, "Index x has not been used");
  });
  test("tables, migrations (newest first), functions", () => {
    assert.deepEqual(parseTables({ tables: [{ name: "public.chats", rls_enabled: true, rows: 13 }, { name: "public.x", rls_enabled: false, rows: null }, { rls_enabled: true }] }), [{ name: "chats", rls: true, rows: 13, columns: [] }, { name: "x", rls: false, rows: null, columns: [] }]);
    assert.deepEqual(parseMigrations({ migrations: [{ version: "1", name: "init" }, { version: "2", name: "next" }] }).map((m) => m.version), ["2", "1"]);
    const f = parseFunctions({ functions: [{ slug: "hello", name: "Hello", status: "ACTIVE", version: 3, updated_at: 1761163383000 }, { name: "no slug" }] });
    assert.equal(f.length, 1);
    assert.equal(f[0]!.updatedAt, new Date(1761163383000).toISOString());
  });
  test("connect: only a publishable key and the project's own address; installed extensions", () => {
    const keys = [{ type: "legacy", api_key: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.abcdefghijklmnop" }, { type: "publishable", api_key: "sb_publishable_AbCdEf123456_xyz" }];
    assert.equal(findPublishableKey(keys), "sb_publishable_AbCdEf123456_xyz");
    assert.equal(findPublishableKey([{ api_key: "sb_secret_abcdefghijklmnopqrstuv" }]), null);
    assert.equal(findPublishableKey([{ api_key: "sb_publishable_AbCdEf123456", disabled: true }]), null);
    const c = parseConnect({ url: `https://${REF}.supabase.co` }, keys, { extensions: [{ name: "pgcrypto", installed_version: "1.3" }, { name: "postgis", installed_version: null }] });
    assert.deepEqual(c, { url: `https://${REF}.supabase.co`, publishableKey: "sb_publishable_AbCdEf123456_xyz", extensions: ["pgcrypto"] });
    assert.equal(parseConnect({ url: "https://evil.example" }, [], []).url, null);
  });
  test("logs: times become ISO, messages are cut", () => {
    const rows = parseLogs({ result: [{ timestamp: "2026-10-22T19:43:19.122000", event_message: "x".repeat(900) }, { timestamp: "garbage", event_message: "no" }] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.time, "2026-10-22T19:43:19.122Z");
    assert.equal(rows[0]!.message.length, 400);
  });
});

describe("the logs query", () => {
  test("only a fixed source ends up in the SQL", () => {
    assert.equal(logsSql("postgres_logs", false), "select timestamp, event_message from logs where source = 'postgres_logs' order by timestamp desc limit 100");
    assert.match(logsSql("edge_logs", true), /status_code'\]\) >= 400/);
    assert.match(logsSql("postgres_logs", true), /parsed\.error_severity'\] in \('ERROR', 'FATAL', 'PANIC'\)/);
    assert.match(logsSql("auth_logs", true), /lower\(severity_text\) in/);
  });
});

describe("the panel", () => {
  const make = (answer: (tool: string, args: Record<string, unknown>) => McpCallResult | Error, rows: RemoteRow[] = [row()]) => {
    const calls: { tool: string; args: Record<string, unknown>; server: string }[] = [];
    const panel = new SupabasePanel({
      list: async () => rows,
      view: view("ready"),
      call: async (_u, req) => {
        calls.push({ tool: req.tool, args: req.args, server: req.server });
        const r = answer(req.tool, req.args);
        if (r instanceof Error) throw r;
        return r;
      },
    });
    return { panel, calls };
  };

  test("every tool the panel can call is a read tool", () => {
    for (const t of READ_TOOLS) assert.doesNotMatch(t, /^(apply_migration|deploy|create|delete|merge|rebase|reset|pause|restore|update)/);
    assert.equal(READ_TOOLS.has("execute_sql"), true);
  });

  test("tables: fields with type and keys, never values, defaults or rules", () => {
    const t = parseTables({
      tables: [
        {
          name: "public.chats",
          rls_enabled: true,
          rows: 14,
          columns: [
            { name: "id", format: "uuid", data_type: "uuid", options: ["updatable"], default_value: "gen_random_uuid()" },
            { name: "project_id", format: "uuid", data_type: "uuid", options: ["nullable", "updatable"], check: "secret check" },
            { name: "tags", format: "_text", data_type: "ARRAY", options: ["unique"] },
            { format: "text" },
          ],
          primary_keys: ["id"],
          foreign_key_constraints: [
            { source_table: "public.chats", source_columns: ["project_id"], target_table: "public.projects", target_columns: ["id"] },
            { source_table: "public.messages", source_columns: ["chat_id"], target_table: "public.chats", target_columns: ["id"] },
          ],
        },
      ],
    });
    assert.deepEqual(t[0]!.columns, [
      { name: "id", type: "uuid", pk: true, unique: false, nullable: false, fk: null },
      { name: "project_id", type: "uuid", pk: false, unique: false, nullable: true, fk: "projects" },
      { name: "tags", type: "text[]", pk: false, unique: true, nullable: false, fk: null },
    ]);
    assert.doesNotMatch(JSON.stringify(t), /gen_random_uuid|secret check/);
  });

  test("users: counts only, from one fixed query", async () => {
    assert.deepEqual(parseUsers([{ total: 7, confirmed: 7, unconfirmed: 0, new_7d: 1, active_7d: 4, methods: [{ provider: "email", count: 6 }, { provider: "google", count: 1 }, { provider: "<b>x</b>", count: 9 }] }]), {
      total: 7, confirmed: 7, unconfirmed: 0, new7d: 1, active7d: 4, methods: [{ provider: "email", count: 6 }, { provider: "google", count: 1 }],
    });
    assert.deepEqual(parseUsers([{ total: "3", methods: '[{"provider":"email","count":3}]' }]).methods, [{ provider: "email", count: 3 }]);
    assert.equal(parseUsers([]).total, null);
    assert.doesNotMatch(USERS_SQL, /\b(email|phone|raw_user_meta_data|encrypted_password)\b/i);
    const { panel, calls } = make(() => ok([{ total: 2 }], true));
    assert.equal((await panel.section("u1", REF, "users")).total, 2);
    assert.deepEqual(calls.map((c) => [c.tool, c.args.project_id, c.args.query]), [["execute_sql", REF, USERS_SQL]]);
  });

  test("overview: project and a fixed read query, with the person's own entry name", async () => {
    const { panel, calls } = make((tool) => (tool === "get_project" ? ok({ name: "muti user chat", region: "sa-east-1", status: "ACTIVE_HEALTHY", database: { version: "17.11.0.003" } }) : ok([{ db_bytes: 1, auth_users: 2, policies: 3, tables: 4, migrations: 5 }], true)));
    const o = await panel.section("u1", REF, "overview");
    assert.equal(o.name, "muti user chat");
    assert.equal(o.authUsers, 2);
    assert.deepEqual(calls.map((c) => c.tool), ["get_project", "execute_sql"]);
    assert.equal(calls[0]!.args.id, REF);
    assert.equal(calls[1]!.args.project_id, REF);
    assert.match(String(calls[1]!.args.query), /^select pg_database_size/);
    assert.equal(calls.every((c) => c.server === "supabase"), true);
  });

  test("overview still works when the counts query is refused", async () => {
    const { panel } = make((tool) => (tool === "get_project" ? ok({ name: "x", database: { version: "17.1" } }) : { text: "permission denied for schema auth", isError: true, truncated: false }));
    const o = await panel.section("u1", REF, "overview");
    assert.equal(o.authUsers, null);
  });

  test("checks: security and performance together", async () => {
    const { panel } = make((_t, args) => ok({ result: { lints: [{ title: args.type === "security" ? "S" : "P", level: args.type === "security" ? "WARN" : "INFO", count: 1, findings: [] }] } }));
    const c = await panel.section("u1", REF, "checks");
    assert.deepEqual(c.items.map((i) => i.title), ["S", "P"]);
  });

  test("logs: a time window of the right size, and the fixed SQL", async () => {
    const { panel, calls } = make(() => ok({ result: [] }, true));
    await panel.section("u1", REF, "logs", { source: "edge_logs", minutes: 15, errorsOnly: true });
    const a = calls[0]!.args;
    assert.equal(new Date(String(a.iso_timestamp_end)).getTime() - new Date(String(a.iso_timestamp_start)).getTime(), 15 * 60_000);
    assert.match(String(a.sql), /where source = 'edge_logs' and toInt32OrZero/);
  });

  test("no Supabase entry: unavailable; a bad reference never reaches Supabase", async () => {
    const none = make(() => ok({}), []);
    await assert.rejects(none.panel.section("u1", REF, "tables"), (e) => e instanceof PanelError && e.code === "unavailable");
    const { panel, calls } = make(() => ok({}));
    await assert.rejects(panel.section("u1", "x'; drop table", "tables"), PanelError);
    assert.equal(calls.length, 0);
  });

  test("failures become fixed sentences the page can act on", async () => {
    const cases: [McpCallResult | Error, string][] = [
      [new RelayError("host", "The server asked for a sign-in again. Tell the person to sign in under Settings > MCP servers.", "mcp_failed"), "needs_sign_in"],
      [new RelayError("host", "That tool is not available (the server is off or does not have it).", "mcp_unavailable"), "unavailable"],
      [new RelayError("busy", "Too many tool calls were made in a short time."), "busy"],
      [new RelayError("timeout", "The tool did not answer in time."), "failed"],
      [{ text: "403 Forbidden: you do not have access to this project", isError: true, truncated: false }, "no_access"],
      [{ text: "something odd happened with secret sbp_123", isError: true, truncated: false }, "failed"],
    ];
    for (const [answer, code] of cases) {
      const { panel } = make(() => answer);
      await assert.rejects(panel.section("u1", REF, "tables"), (e) => e instanceof PanelError && e.code === code && !/sbp_123|Settings >/.test(e.message), code);
    }
  });

  test("projects: lists the person's own Supabase projects", async () => {
    const { panel, calls } = make(() => ok({ projects: [{ ref: REF, name: "muti user chat", region: "sa-east-1", status: "ACTIVE_HEALTHY" }] }));
    assert.equal((await panel.projects("u1")).length, 1);
    assert.deepEqual(calls[0]!.args, {});
  });
});
