import {
  isSupabaseMcpUrl,
  SUPABASE_LOG_SOURCES,
  SUPABASE_REF_PATTERN,
  type McpCallResult,
  type McpRemoteServer,
  type SupabaseCheck,
  type SupabaseConnect,
  type SupabaseFailure,
  type SupabaseFunction,
  type SupabaseLogRow,
  type SupabaseLogSource,
  type SupabaseMigration,
  type SupabaseMine,
  type SupabaseOverview,
  type SupabaseProjectOption,
  type SupabaseSection,
  type SupabaseSectionData,
  type SupabaseColumn,
  type SupabaseTable,
  type SupabaseUsers,
} from "@mc/shared";
import { RelayError } from "./folder-relay.ts";
import type { McpRequest } from "./mcp-relay.ts";
import type { RemoteRow } from "./mcp-remote-store.ts";

// The Supabase tab reads a linked project through the person's OWN Supabase connection (the hosted Supabase MCP server in
// their MCP servers). This file is the only thing that talks to it for the tab, and it can only call the tools in READ_TOOLS:
// the tab never changes anything. Everything the Supabase server returns is data written by someone else (log lines, table
// and function names): it is parsed, cut to size and sent on as plain text, never run and never handed to the AI.

/** The only tools the tab may call. All of them read. */
export const READ_TOOLS = new Set(["list_projects", "get_project", "list_tables", "list_migrations", "get_advisors", "query_logs", "list_extensions", "list_edge_functions", "get_project_url", "get_publishable_keys", "execute_sql"]);

/** A failure the page can act on. `message` is a fixed sentence; the server's own words stay in the log. */
export class PanelError extends Error {
  constructor(
    readonly code: SupabaseFailure,
    message: string,
  ) {
    super(message);
  }
}

const SAY: Record<SupabaseFailure, string> = {
  needs_sign_in: "Sign in to Supabase again.",
  no_access: "Your Supabase account has no access to this project.",
  busy: "Too many requests to Supabase in a short time. Try again in a minute.",
  unavailable: "Supabase is not available. Check that it is on in your MCP servers.",
  failed: "Could not read that from Supabase. Try again.",
};
const fail = (code: SupabaseFailure) => new PanelError(code, SAY[code]);

export type PanelDeps = {
  list: (userId: string) => Promise<RemoteRow[]>;
  view: (row: RemoteRow) => McpRemoteServer;
  call: (userId: string, req: McpRequest) => Promise<McpCallResult>;
};

/** The person's Supabase entry: an enabled one first. */
export function supabaseRowOf(rows: RemoteRow[]): RemoteRow | null {
  const mine = rows.filter((r) => isSupabaseMcpUrl(r.url));
  return mine.find((r) => r.enabled) ?? mine[0] ?? null;
}

export function mineOf(row: RemoteRow | null, view: (row: RemoteRow) => McpRemoteServer): SupabaseMine {
  if (!row) return { state: "none" };
  if (!row.enabled) return { state: "off", serverId: row.id };
  const v = view(row);
  return { state: v.status === "off" ? "off" : v.status, serverId: row.id, ...(v.error ? { error: v.error } : {}) };
}

// ------------------------------------------------------------------------------------------------ reading answers

/** The JSON in a tool's answer. Some tools wrap their data in <untrusted-data-...> markers; the data is what is inside. */
export function parseAnswer(text: string): unknown {
  const wrapped = /<untrusted-data-[\w-]+>\s*([\s\S]*?)\s*<\/untrusted-data-[\w-]+>/.exec(text);
  const body = (wrapped?.[1] ?? text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    if (start < 0) throw fail("failed");
    try {
      return JSON.parse(body.slice(start));
    } catch {
      throw fail("failed");
    }
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export function parseProjects(data: unknown): SupabaseProjectOption[] {
  const list = isObj(data) ? arr(data.projects) : arr(data);
  const out: SupabaseProjectOption[] = [];
  for (const p of list) {
    if (!isObj(p)) continue;
    const ref = str(p.ref ?? p.id, 40);
    if (!SUPABASE_REF_PATTERN.test(ref)) continue;
    out.push({ ref, name: str(p.name, 120) || ref, region: /^[a-z0-9-]{0,40}$/.test(str(p.region, 40)) ? str(p.region, 40) : "", status: str(p.status, 40) });
  }
  return out.slice(0, 100);
}

export function parseOverview(project: unknown, stats: unknown): SupabaseOverview {
  const p = isObj(project) ? project : {};
  const db = isObj(p.database) ? p.database : {};
  const row = isObj(arr(stats)[0]) ? (arr(stats)[0] as Record<string, unknown>) : {};
  return {
    name: str(p.name, 120),
    region: str(p.region, 40),
    status: str(p.status, 40),
    postgres: str(db.version, 40).split(".").slice(0, 2).join("."),
    dbBytes: num(row.db_bytes),
    authUsers: num(row.auth_users),
    policies: num(row.policies),
    tables: num(row.tables),
    migrations: num(row.migrations),
  };
}

/** Counts about the project, one fixed read-only query. Nothing in it comes from a person or from Supabase. */
export const OVERVIEW_SQL =
  "select pg_database_size(current_database())::bigint as db_bytes, " +
  "(select count(*) from auth.users)::int as auth_users, " +
  "(select count(*) from pg_policies where schemaname = 'public')::int as policies, " +
  "(select count(*) from pg_tables where schemaname = 'public')::int as tables, " +
  "(select count(*) from supabase_migrations.schema_migrations)::int as migrations";

const LEVELS = ["ERROR", "WARN", "INFO"] as const;
/** A fix guide is shown as a link only when it points at supabase.com. */
const safeGuide = (v: unknown): string | null => {
  try {
    const u = new URL(str(v, 500));
    return u.protocol === "https:" && (u.hostname === "supabase.com" || u.hostname.endsWith(".supabase.com")) ? u.href : null;
  } catch {
    return null;
  }
};

export function parseChecks(data: unknown, kind: SupabaseCheck["kind"]): SupabaseCheck[] {
  const lints = isObj(data) && isObj(data.result) ? arr(data.result.lints) : isObj(data) ? arr(data.lints) : [];
  const out: SupabaseCheck[] = [];
  for (const l of lints) {
    if (!isObj(l)) continue;
    const level = (LEVELS as readonly string[]).includes(str(l.level, 10)) ? (str(l.level, 10) as SupabaseCheck["level"]) : "INFO";
    const first = arr(l.findings)[0];
    out.push({
      kind,
      level,
      title: str(l.title, 120),
      detail: str(isObj(first) ? first.detail : l.description, 300).replace(/\\`|`/g, ""),
      count: num(l.count) ?? 1,
      url: safeGuide(l.remediation),
    });
  }
  return out.slice(0, 40);
}

export const byLevel = (a: SupabaseCheck, b: SupabaseCheck) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level);

const tableName = (v: unknown) => str(v, 120).replace(/^public\./, "");

/** "_uuid" is how Postgres names an array of uuid. */
const typeName = (c: Record<string, unknown>) => {
  const f = str(c.format, 60) || str(c.data_type, 60);
  return f.startsWith("_") ? `${f.slice(1)}[]` : f;
};

/** Tables with their fields, from list_tables. Only structure is read: names, types, keys. Defaults and check rules are left out. */
export function parseTables(data: unknown): SupabaseTable[] {
  const list = isObj(data) ? arr(data.tables) : arr(data);
  return list
    .filter(isObj)
    .map((t) => {
      const name = tableName(t.name);
      const pks = new Set(arr(t.primary_keys).map((k) => str(k, 120)));
      const fks = new Map<string, string>();
      for (const f of arr(t.foreign_key_constraints)) {
        if (!isObj(f) || tableName(f.source_table) !== name) continue;
        const target = tableName(f.target_table);
        for (const col of arr(f.source_columns)) fks.set(str(col, 120), target);
      }
      const columns: SupabaseColumn[] = arr(t.columns)
        .filter(isObj)
        .map((c) => {
          const options = arr(c.options).map((o) => str(o, 30));
          const cname = str(c.name, 120);
          return { name: cname, type: typeName(c), pk: pks.has(cname), unique: options.includes("unique"), nullable: options.includes("nullable"), fk: fks.get(cname) ?? null };
        })
        .filter((c) => c.name)
        .slice(0, 200);
      return { name, rls: t.rls_enabled === true, rows: num(t.rows), columns };
    })
    .filter((t) => t.name)
    .slice(0, 200);
}

/** Counts of the people who sign in, one fixed read-only query. Nothing in it comes from a person. */
export const USERS_SQL =
  "select count(*)::int as total, count(confirmed_at)::int as confirmed, " +
  "(count(*) filter (where confirmed_at is null))::int as unconfirmed, " +
  "(count(*) filter (where created_at > now() - interval '7 days'))::int as new_7d, " +
  "(count(*) filter (where last_sign_in_at > now() - interval '7 days'))::int as active_7d, " +
  "(select coalesce(json_agg(json_build_object('provider', provider, 'count', n)), '[]'::json) from " +
  "(select provider, count(*)::int as n from auth.identities group by provider order by n desc limit 10) m) as methods " +
  "from auth.users";

export function parseUsers(data: unknown): SupabaseUsers {
  const row = isObj(arr(data)[0]) ? (arr(data)[0] as Record<string, unknown>) : {};
  let methods = row.methods;
  if (typeof methods === "string") {
    try {
      methods = JSON.parse(methods);
    } catch {
      methods = [];
    }
  }
  return {
    total: num(row.total),
    confirmed: num(row.confirmed),
    unconfirmed: num(row.unconfirmed),
    new7d: num(row.new_7d),
    active7d: num(row.active_7d),
    methods: arr(methods)
      .filter(isObj)
      .map((m) => ({ provider: str(m.provider, 30).toLowerCase(), count: num(m.count) ?? 0 }))
      .filter((m) => /^[a-z0-9_.-]{1,30}$/.test(m.provider))
      .slice(0, 10),
  };
}

export function parseMigrations(data: unknown): SupabaseMigration[] {
  const list = isObj(data) ? arr(data.migrations) : arr(data);
  return list
    .filter(isObj)
    .map((m) => ({ version: str(m.version, 40), name: str(m.name, 120) }))
    .filter((m) => m.version)
    .reverse()
    .slice(0, 100);
}

const iso = (v: unknown): string | null => {
  let d: Date | null = null;
  if (typeof v === "number") d = new Date(v);
  else if (typeof v === "string" && v) d = new Date(/^\d+$/.test(v) ? Number(v) : /(Z|[+-]\d\d:?\d\d)$/.test(v) ? v : `${v}Z`);
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

export function parseFunctions(data: unknown): SupabaseFunction[] {
  const list = isObj(data) ? arr(data.functions) : arr(data);
  return list
    .filter(isObj)
    .map((f) => ({ slug: str(f.slug, 80), name: str(f.name, 120), status: str(f.status, 40), version: num(f.version), updatedAt: iso(f.updated_at) }))
    .filter((f) => f.slug)
    .slice(0, 100);
}

/** A publishable key (`sb_publishable_...`) is public by design. Looked for anywhere in the answer; nothing else is passed on. */
export function findPublishableKey(data: unknown, depth = 0): string | null {
  if (typeof data === "string") return /^sb_publishable_[A-Za-z0-9_-]{10,200}$/.test(data) ? data : null;
  if (depth > 5) return null;
  for (const v of Array.isArray(data) ? data : isObj(data) ? Object.values(data) : []) {
    if (isObj(v) && v.disabled === true) continue;
    const k = findPublishableKey(v, depth + 1);
    if (k) return k;
  }
  return null;
}

export function parseConnect(url: unknown, keys: unknown, extensions: unknown): SupabaseConnect {
  const u = isObj(url) ? str(url.url, 200) : "";
  const exts = (isObj(extensions) ? arr(extensions.extensions) : arr(extensions)).filter(isObj).filter((e) => e.installed_version !== null && e.installed_version !== undefined).map((e) => str(e.name, 60)).filter(Boolean);
  return { url: /^https:\/\/[a-z]{20}\.supabase\.co\/?$/.test(u) ? u : null, publishableKey: findPublishableKey(keys), extensions: exts.slice(0, 40) };
}

// ------------------------------------------------------------------------------------------------ logs

export function isLogSource(v: string): v is SupabaseLogSource {
  return (SUPABASE_LOG_SOURCES as readonly string[]).includes(v);
}

/** The logs query for one source. `source` is one of a fixed list, so nothing a person types ever reaches the SQL. */
export function logsSql(source: SupabaseLogSource, errorsOnly: boolean): string {
  let filter = "";
  if (errorsOnly) {
    if (source === "edge_logs" || source === "function_edge_logs") filter = " and toInt32OrZero(log_attributes['response.status_code']) >= 400";
    else if (source === "postgres_logs") filter = " and log_attributes['parsed.error_severity'] in ('ERROR', 'FATAL', 'PANIC')";
    else filter = " and lower(severity_text) in ('error', 'fatal', 'panic')";
  }
  return `select timestamp, event_message from logs where source = '${source}'${filter} order by timestamp desc limit 100`;
}

export function parseLogs(data: unknown): SupabaseLogRow[] {
  const list = isObj(data) ? arr(data.result) : arr(data);
  return list
    .filter(isObj)
    .map((r) => ({ time: iso(r.timestamp) ?? "", message: str(r.event_message, 400) }))
    .filter((r) => r.time)
    .slice(0, 100);
}

// ------------------------------------------------------------------------------------------------ the panel

export class SupabasePanel {
  constructor(private readonly d: PanelDeps) {}

  /** The person's own Supabase entry, or why there is none. */
  private async rowOf(userId: string): Promise<RemoteRow> {
    const row = supabaseRowOf(await this.d.list(userId));
    if (!row) throw fail("unavailable");
    return row;
  }

  /** One read-only call. Anything not in READ_TOOLS is refused here, whoever asks. */
  private async run(userId: string, row: RemoteRow, tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!READ_TOOLS.has(tool)) throw new Error(`The Supabase tab may not call ${tool}`);
    let res: McpCallResult;
    try {
      res = await this.d.call(userId, { server: row.name, tool, args });
    } catch (e) {
      if (e instanceof RelayError) {
        if (e.code === "mcp_unavailable") throw fail("unavailable");
        if (e.kind === "busy") throw fail("busy");
        if (/sign.?in/i.test(e.message)) throw fail("needs_sign_in");
      }
      throw fail("failed");
    }
    if (res.isError) {
      console.error("[supabase-panel] tool error:", tool, res.text.slice(0, 200));
      throw fail(/\b(40[13]|forbidden|not authorized|unauthori[sz]ed|permission|access|not found|does not exist)\b/i.test(res.text) ? "no_access" : "failed");
    }
    return parseAnswer(res.text);
  }

  /** The projects in the person's own Supabase account, to link one. */
  async projects(userId: string): Promise<SupabaseProjectOption[]> {
    const row = await this.rowOf(userId);
    return parseProjects(await this.run(userId, row, "list_projects", {}));
  }

  /** One section of a linked project. Calls are made one after another: a person may only have a few in flight. */
  async section<S extends SupabaseSection>(userId: string, ref: string, section: S, opts: { source?: SupabaseLogSource; minutes?: number; errorsOnly?: boolean } = {}): Promise<SupabaseSectionData[S]> {
    if (!SUPABASE_REF_PATTERN.test(ref)) throw fail("failed");
    const row = await this.rowOf(userId);
    const go = (tool: string, args: Record<string, unknown>) => this.run(userId, row, tool, { project_id: ref, ...args });
    let out: unknown;
    switch (section) {
      case "overview": {
        const project = await this.run(userId, row, "get_project", { id: ref });
        const stats = await go("execute_sql", { query: OVERVIEW_SQL }).catch(() => []); // counts are a bonus: a read-only role may not see every schema
        out = parseOverview(project, stats);
        break;
      }
      case "checks": {
        const security = await go("get_advisors", { type: "security" });
        const performance = await go("get_advisors", { type: "performance" }).catch(() => ({}));
        out = { items: [...parseChecks(security, "security"), ...parseChecks(performance, "performance")].sort(byLevel) };
        break;
      }
      case "tables":
        out = { tables: parseTables(await go("list_tables", { schemas: ["public"], verbose: true })) };
        break;
      case "users":
        out = parseUsers(await go("execute_sql", { query: USERS_SQL }));
        break;
      case "migrations":
        out = { migrations: parseMigrations(await go("list_migrations", {})) };
        break;
      case "functions":
        out = { functions: parseFunctions(await go("list_edge_functions", {})) };
        break;
      case "connect": {
        const url = await go("get_project_url", {});
        const keys = await go("get_publishable_keys", {}).catch(() => ({}));
        const exts = await go("list_extensions", {}).catch(() => ({}));
        out = parseConnect(url, keys, exts);
        break;
      }
      case "logs": {
        const source = opts.source ?? "postgres_logs";
        const end = new Date();
        const start = new Date(end.getTime() - (opts.minutes ?? 60) * 60_000);
        out = { source, rows: parseLogs(await go("query_logs", { sql: logsSql(source, opts.errorsOnly === true), iso_timestamp_start: start.toISOString(), iso_timestamp_end: end.toISOString() })) };
        break;
      }
    }
    return out as SupabaseSectionData[S];
  }
}
