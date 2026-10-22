// The Supabase tab of the Files card: a Nido project is linked to one Supabase project; each person looks at it through
// their own Supabase connection (the hosted Supabase MCP server in their MCP servers). Types shared by the chat server and
// the page, and the small rules both apply.

export const SUPABASE_MCP_HOST = "mcp.supabase.com";
/** What "Connect Supabase" adds to a person's MCP servers: the hosted server, read-only. */
export const SUPABASE_MCP_URL = `https://${SUPABASE_MCP_HOST}/mcp?read_only=true`;
/** A Supabase project reference: 20 lowercase letters. */
export const SUPABASE_REF_PATTERN = /^[a-z]{20}$/;

/** Whether an MCP server address is the hosted Supabase one. Only the host counts, not the path or the query. */
export function isSupabaseMcpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.toLowerCase() === SUPABASE_MCP_HOST && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** The link between a Nido project and a Supabase project. Public facts only: no keys, no secrets. */
export type SupabaseLink = { ref: string; name: string; region: string; linked_by: string | null; linked_at: string };

/** How this person's own Supabase connection is doing. `none`: no Supabase entry in their MCP servers. */
export type SupabaseMine = {
  state: "none" | "ready" | "needs_sign_in" | "connecting" | "failed" | "off";
  /** The id of their Supabase entry in the MCP servers, when there is one (for Sign in). */
  serverId?: string;
  error?: string;
};

export type SupabaseState = {
  link: SupabaseLink | null;
  mine: SupabaseMine;
  /** The host and admins link, change and unlink. */
  canLink: boolean;
  /** False when this chat server has no public address, so a Supabase sign-in cannot work. */
  oauthAvailable: boolean;
};

/** The Files card shows the Supabase tab only for a linked project, and only to someone who has set Supabase up. */
export function showSupabaseTab(state: Pick<SupabaseState, "link" | "mine"> | null): boolean {
  return !!state && state.link !== null && state.mine.state !== "none";
}

/** One Supabase project in the person's own account, to pick from when linking. */
export type SupabaseProjectOption = { ref: string; name: string; region: string; status: string };

export const SUPABASE_SECTIONS = ["overview", "checks", "tables", "users", "migrations", "logs", "functions", "connect"] as const;
export type SupabaseSection = (typeof SUPABASE_SECTIONS)[number];

export const SUPABASE_LOG_SOURCES = ["edge_logs", "postgres_logs", "auth_logs", "auth_audit_logs", "postgrest_logs", "realtime_logs", "pgbouncer_logs", "function_edge_logs", "function_logs", "storage_logs"] as const;
export type SupabaseLogSource = (typeof SUPABASE_LOG_SOURCES)[number];
/** Minutes. The logs window is at most 24 hours. */
export const SUPABASE_LOG_WINDOWS = [15, 60, 360, 1440] as const;

export type SupabaseOverview = {
  name: string;
  region: string;
  status: string;
  postgres: string;
  dbBytes: number | null;
  authUsers: number | null;
  policies: number | null;
  tables: number | null;
  migrations: number | null;
};
export type SupabaseCheck = { kind: "security" | "performance"; level: "ERROR" | "WARN" | "INFO"; title: string; detail: string; count: number; url: string | null };
/** One field of a table: its name and type, and what the table says about it. Never a value stored in it. */
export type SupabaseColumn = { name: string; type: string; pk: boolean; unique: boolean; nullable: boolean; /** The table this field points to, when it is a foreign key. */ fk: string | null };
export type SupabaseTable = { name: string; rls: boolean; rows: number | null; columns: SupabaseColumn[] };
/** Counts about the people who sign in to the project. No names, emails or ids. */
export type SupabaseUsers = { total: number | null; confirmed: number | null; unconfirmed: number | null; new7d: number | null; active7d: number | null; methods: { provider: string; count: number }[] };
export type SupabaseMigration = { version: string; name: string };
export type SupabaseLogRow = { time: string; message: string };
export type SupabaseFunction = { slug: string; name: string; status: string; version: number | null; updatedAt: string | null };
export type SupabaseConnect = { url: string | null; publishableKey: string | null; extensions: string[] };

export type SupabaseSectionData = {
  overview: SupabaseOverview;
  checks: { items: SupabaseCheck[] };
  tables: { tables: SupabaseTable[] };
  users: SupabaseUsers;
  migrations: { migrations: SupabaseMigration[] };
  logs: { source: SupabaseLogSource; rows: SupabaseLogRow[] };
  functions: { functions: SupabaseFunction[] };
  connect: SupabaseConnect;
};

/** Why a section could not be read, in words the page can act on. */
export type SupabaseFailure = "needs_sign_in" | "no_access" | "busy" | "unavailable" | "failed";
