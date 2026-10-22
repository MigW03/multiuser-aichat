import {
  isVercelMcpUrl,
  redactSecrets,
  VERCEL_DEPLOYMENT_PATTERN,
  VERCEL_PROJECT_PATTERN,
  VERCEL_SLUG_PATTERN,
  VERCEL_TEAM_PATTERN,
  type McpCallResult,
  type McpRemoteServer,
  type VercelBuildLine,
  type VercelDeployment,
  type VercelDomain,
  type VercelEnvVar,
  type VercelErrorsData,
  type VercelFailure,
  type VercelLink,
  type VercelLogsData,
  type VercelMine,
  type VercelOverview,
  type VercelProjectOption,
  type VercelSection,
  type VercelSectionData,
} from "@mc/shared";
import { RelayError } from "./folder-relay.ts";
import type { RemoteRow } from "./mcp-remote-store.ts";
import type { PanelDeps } from "./supabase-panel.ts";

// The Vercel tab reads a linked project through the person's OWN Vercel connection (the hosted Vercel MCP server in their
// MCP servers). This file is the only thing that talks to it for the tab, and it can only call the tools in READ_TOOLS:
// the tab never changes anything. Everything the Vercel server returns is data written by someone else (commit messages,
// build output, error text): it is parsed, cut to size and sent on as plain text, never run and never handed to the AI.
// An environment variable's VALUE is never read on purpose: the parser keeps names, targets and types only, and the call
// never asks for decrypted values.

/** The only tools the tab may call. All of them read. */
export const READ_TOOLS = new Set(["list_teams", "list_projects", "get_project", "list_deployments", "get_deployment", "list_deployment_events", "get_runtime_errors", "get_runtime_logs", "list_project_domains", "get_domain_config", "filter_project_envs"]);

/** A failure the page can act on. `message` is a fixed sentence; the server's own words stay in the log. */
export class VercelPanelError extends Error {
  constructor(
    readonly code: VercelFailure,
    message: string,
  ) {
    super(message);
  }
}

const SAY: Record<VercelFailure, string> = {
  needs_sign_in: "Sign in to Vercel again.",
  no_access: "Your Vercel account has no access to this project.",
  busy: "Too many requests to Vercel in a short time. Try again in a minute.",
  unavailable: "Vercel is not available. Check that it is on in your MCP servers.",
  window: "Your Vercel plan does not keep logs that far back. Try a shorter window.",
  failed: "Could not read that from Vercel. Try again.",
};
const fail = (code: VercelFailure) => new VercelPanelError(code, SAY[code]);

/** The person's Vercel entry: an enabled one first. */
export function vercelRowOf(rows: RemoteRow[]): RemoteRow | null {
  const mine = rows.filter((r) => isVercelMcpUrl(r.url));
  return mine.find((r) => r.enabled) ?? mine[0] ?? null;
}

export function vercelMineOf(row: RemoteRow | null, view: (row: RemoteRow) => McpRemoteServer): VercelMine {
  if (!row) return { state: "none" };
  if (!row.enabled) return { state: "off", serverId: row.id };
  const v = view(row);
  return { state: v.status === "off" ? "off" : v.status, serverId: row.id, ...(v.error ? { error: v.error } : {}) };
}

// ------------------------------------------------------------------------------------------------ reading answers

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const iso = (v: unknown): string | null => {
  const ms = typeof v === "number" ? v : typeof v === "string" && v ? (/^\d+$/.test(v) ? Number(v) : Date.parse(v)) : NaN;
  const d = Number.isFinite(ms) ? new Date(ms) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
/** One line of text written by someone else: no colour codes, no control characters, secrets masked, cut to size. */
const line = (v: unknown, max = 400): string => redactSecrets(str(typeof v === "string" ? v.replace(ANSI, "") : v, max));

/** What a tool answered: its JSON (the Vercel server wraps data in {"result": ...}), or the text itself when it is not JSON. */
export function answerOf(text: string): unknown {
  const body = text.trim();
  try {
    const parsed: unknown = JSON.parse(body);
    return isObj(parsed) && "result" in parsed ? parsed.result : parsed;
  } catch {
    return body;
  }
}

/** The host of an address, when it is a plain host name. */
const hostOf = (v: unknown): string => {
  const raw = str(v, 253).replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  return /^[A-Za-z0-9.-]+$/.test(raw) ? raw : "";
};
const vercelPage = (v: unknown): string | null => {
  try {
    const u = new URL(str(v, 500));
    return u.protocol === "https:" && (u.hostname === "vercel.com" || u.hostname.endsWith(".vercel.com")) ? u.href : null;
  } catch {
    return null;
  }
};

export function parseTeams(data: unknown): { id: string; slug: string; name: string }[] {
  const list = isObj(data) ? arr(data.teams) : arr(data);
  const out: { id: string; slug: string; name: string }[] = [];
  for (const t of list) {
    if (!isObj(t)) continue;
    const id = str(t.id, 60);
    const slug = str(t.slug, 63).toLowerCase();
    if (!VERCEL_TEAM_PATTERN.test(id) || !VERCEL_SLUG_PATTERN.test(slug)) continue;
    out.push({ id, slug, name: str(t.name, 120) || slug });
  }
  return out.slice(0, 10);
}

export function parseProjects(data: unknown, team: { id: string; slug: string; name: string }): VercelProjectOption[] {
  const list = isObj(data) ? arr(data.projects) : arr(data);
  const out: VercelProjectOption[] = [];
  for (const p of list) {
    if (!isObj(p)) continue;
    const projectId = str(p.id, 60);
    if (!VERCEL_PROJECT_PATTERN.test(projectId)) continue;
    out.push({ teamId: team.id, teamSlug: team.slug, teamName: team.name, projectId, name: str(p.name, 120) || projectId });
  }
  return out.slice(0, 100);
}

/** The first line of a commit message. */
const firstLine = (v: unknown): string => (typeof v === "string" ? (v.split(/\r?\n/)[0] ?? "") : "");

export function parseDeployment(d: unknown): VercelDeployment | null {
  if (!isObj(d)) return null;
  const id = str(d.id ?? d.uid, 60);
  if (!VERCEL_DEPLOYMENT_PATTERN.test(id)) return null;
  const meta = isObj(d.meta) ? d.meta : {};
  const git = isObj(d.gitSource) ? d.gitSource : {};
  const creator = isObj(d.creator) ? d.creator : {};
  return {
    id,
    state: str(d.state ?? d.readyState, 30).toUpperCase(),
    target: d.target === "production" ? "production" : "preview",
    branch: line(meta.githubCommitRef ?? meta.gitCommitRef ?? git.ref, 100),
    sha: str(meta.githubCommitSha ?? meta.gitCommitSha ?? git.sha, 60).slice(0, 7),
    message: line(firstLine(meta.githubCommitMessage ?? meta.gitCommitMessage ?? git.message), 120),
    author: line(creator.username ?? meta.githubCommitAuthorLogin, 60),
    createdAt: iso(d.created ?? d.createdAt),
    host: hostOf(d.url),
    inspectorUrl: vercelPage(d.inspectorUrl),
  };
}

export function parseDeployments(data: unknown): VercelDeployment[] {
  const outer = isObj(data) ? data.deployments : data;
  const list = isObj(outer) ? arr(outer.deployments) : arr(outer);
  return list.map(parseDeployment).filter((d): d is VercelDeployment => d !== null).slice(0, 30);
}

export function parseOverview(project: unknown, production: VercelDeployment | null): VercelOverview {
  const p = isObj(project) ? project : {};
  const link = isObj(p.link) ? p.link : {};
  const domains = arr(p.domains).map((d) => hostOf(isObj(d) ? d.name : d)).filter(Boolean);
  const org = str(link.org, 80);
  const repo = str(link.repo, 120);
  return {
    name: str(p.name, 120),
    framework: str(p.framework, 40),
    node: str(p.nodeVersion, 20),
    repo: org && repo ? `${org}/${repo}` : repo,
    production,
    domain: domains.find((d) => !d.endsWith(".vercel.app")) ?? domains[0] ?? null,
  };
}

const MD = /[*`]|^#{1,6}\s*/g;
const plainLines = (text: string, max = 40): string[] =>
  text
    .split("\n")
    .map((l) => line(l.replace(MD, ""), 300))
    .filter((l) => l && !/^(project|time range|runtime errors|runtime logs)\b\s*:?/i.test(l))
    .slice(0, max);

/** One entry of a list the Vercel server returned as JSON, written as a line of text. */
const entryLine = (e: unknown): string => {
  if (!isObj(e)) return line(e, 300);
  const count = num(e.count ?? e.occurrences);
  const what = str(e.message ?? e.name ?? e.error ?? e.text ?? e.event_message ?? e.msg, 300);
  const where = str(e.route ?? e.path ?? e.requestPath, 120);
  const when = iso(e.timestamp ?? e.lastSeen ?? e.last_seen ?? e.time ?? e.created);
  const level = str(e.level, 12);
  return line([count !== null ? `${count}×` : "", level, what, where ? `· ${where}` : "", when ? `· ${when.slice(0, 16).replace("T", " ")}Z` : ""].filter(Boolean).join(" "), 300);
};
const entriesOf = (data: unknown): unknown[] => {
  if (Array.isArray(data)) return data;
  if (!isObj(data)) return [];
  for (const k of ["groups", "errors", "clusters", "logs", "events", "items", "result"]) if (Array.isArray(data[k])) return data[k] as unknown[];
  return [];
};

export function parseErrors(data: unknown): VercelErrorsData {
  if (typeof data === "string") {
    const none = /\bno runtime errors\b/i.test(data);
    return { none, lines: none ? [] : plainLines(data) };
  }
  const lines = entriesOf(data).map(entryLine).filter(Boolean).slice(0, 40);
  return { none: lines.length === 0, lines };
}

export function parseLogs(data: unknown): VercelLogsData {
  if (typeof data === "string") return { lines: /\bno (runtime )?logs\b/i.test(data) ? [] : plainLines(data, 60) };
  return { lines: entriesOf(data).map(entryLine).filter(Boolean).slice(0, 60) };
}

/** Domains with whether their DNS is set up (filled in by the caller, one check per domain). */
export function parseDomains(data: unknown): VercelDomain[] {
  const list = isObj(data) ? arr(data.domains) : arr(data);
  return list
    .filter(isObj)
    .map((d) => ({ name: hostOf(d.name), verified: d.verified === true, redirect: hostOf(d.redirect) || null, configured: null as boolean | null }))
    .filter((d) => d.name)
    .slice(0, 20);
}

/** The id of the project a deployment belongs to, from get_deployment. */
export function deploymentProjectId(answer: unknown): string {
  const d = isObj(answer) && isObj(answer.deployment) ? answer.deployment : answer;
  if (!isObj(d)) return "";
  return str(isObj(d.project) ? d.project.id : d.projectId, 60);
}

export function parseDomainConfig(data: unknown): boolean | null {
  return isObj(data) && typeof data.misconfigured === "boolean" ? !data.misconfigured : null;
}

const TARGETS = new Set(["production", "preview", "development"]);
/** Variables: name, where it applies, type. The value is never read, even when the answer carries it. */
export function parseEnv(data: unknown): VercelEnvVar[] {
  const list = isObj(data) ? arr(data.envs) : arr(data);
  return list
    .filter(isObj)
    .map((e) => {
      const key = str(e.key, 120);
      const raw = Array.isArray(e.target) ? e.target : typeof e.target === "string" ? [e.target] : [];
      const targets = raw.map((t) => str(t, 40).toLowerCase()).filter((t) => TARGETS.has(t));
      const custom = arr(e.customEnvironmentIds).length > 0 ? ["custom"] : [];
      return { key, targets: [...targets, ...custom], type: str(e.type, 20), updatedAt: iso(e.updatedAt ?? e.createdAt) };
    })
    .filter((e) => /^[A-Za-z0-9_.-]{1,120}$/.test(e.key))
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, 200);
}

export function parseBuildLog(data: unknown, errorsOnly: boolean): VercelBuildLine[] {
  const list = isObj(data) ? arr(data.events) : arr(data);
  const rows: VercelBuildLine[] = list
    .filter(isObj)
    .map((e) => {
      const text = line(e.text ?? e.payload, 400);
      const type = str(e.type, 20);
      return { time: iso(e.created ?? e.date), text, level: (type === "stderr" || type === "error" || /\b(error|failed|ERR!)\b/i.test(text) ? "error" : "info") as VercelBuildLine["level"], type };
    })
    .filter((r) => r.text && (r.type === "" || r.type === "stdout" || r.type === "stderr" || r.type === "error" || r.type === "command"))
    .map(({ time, text, level }) => ({ time, text, level }));
  return (errorsOnly ? rows.filter((r) => r.level === "error") : rows).slice(-200);
}

// ------------------------------------------------------------------------------------------------ the panel

export class VercelPanel {
  constructor(private readonly d: PanelDeps) {}

  /** The person's own Vercel entry, or why there is none. */
  private async rowOf(userId: string): Promise<RemoteRow> {
    const row = vercelRowOf(await this.d.list(userId));
    if (!row) throw fail("unavailable");
    return row;
  }

  /** One read-only call. Anything not in READ_TOOLS is refused here, whoever asks. */
  private async run(userId: string, row: RemoteRow, tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!READ_TOOLS.has(tool)) throw new Error(`The Vercel tab may not call ${tool}`);
    if ("decrypt" in args) throw new Error("The Vercel tab never asks for decrypted values");
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
      console.error("[vercel-panel] tool error:", tool, res.text.slice(0, 200));
      if (/\b(retention|retain|Observability Plus)\b/i.test(res.text)) throw fail("window");
      throw fail(/\b(40[13]|forbidden|not authorized|unauthori[sz]ed|permission|access|not.?found|does not exist)\b/i.test(res.text) ? "no_access" : "failed");
    }
    return answerOf(res.text);
  }

  /** The projects in the person's own Vercel account (each team they belong to), to link one. */
  async projects(userId: string): Promise<VercelProjectOption[]> {
    const row = await this.rowOf(userId);
    const teams = parseTeams(await this.run(userId, row, "list_teams", {}));
    const out: VercelProjectOption[] = [];
    for (const team of teams.slice(0, 5)) out.push(...parseProjects(await this.run(userId, row, "list_projects", { teamId: team.id }), team));
    return out.slice(0, 200);
  }

  /** One section of a linked project. Calls are made one after another: a person may only have a few in flight. */
  async section<S extends VercelSection>(userId: string, link: Pick<VercelLink, "teamId" | "projectId">, section: S, opts: { minutes?: number; since?: string; errorsOnly?: boolean; deployment?: string } = {}): Promise<VercelSectionData[S]> {
    if (!VERCEL_TEAM_PATTERN.test(link.teamId) || !VERCEL_PROJECT_PATTERN.test(link.projectId)) throw fail("failed");
    const row = await this.rowOf(userId);
    const scope = { teamId: link.teamId };
    const go = (tool: string, args: Record<string, unknown>) => this.run(userId, row, tool, { ...scope, ...args });
    let out: unknown;
    switch (section) {
      case "overview": {
        const project = await go("get_project", { idOrName: link.projectId });
        const latest = parseDeployments(await go("list_deployments", { projectId: link.projectId, target: "production", limit: 1 }).catch(() => ({})));
        out = parseOverview(project, latest[0] ?? null);
        break;
      }
      case "deployments":
        out = { deployments: parseDeployments(await go("list_deployments", { projectId: link.projectId, limit: 15 })) };
        break;
      case "errors":
        out = parseErrors(await go("get_runtime_errors", { projectId: link.projectId, since: opts.since === "7d" ? "7d" : "24h" }));
        break;
      case "logs":
        out = parseLogs(await go("get_runtime_logs", { projectId: link.projectId, since: `${opts.minutes ?? 30}m`, limit: 50, ...(opts.errorsOnly ? { level: ["error", "fatal"] } : {}) }));
        break;
      case "domains": {
        const domains = parseDomains(await go("list_project_domains", { idOrName: link.projectId, limit: 20 }));
        for (const d of domains.slice(0, 6)) d.configured = parseDomainConfig(await go("get_domain_config", { domain: d.name, projectIdOrName: link.projectId }).catch(() => null));
        out = { domains };
        break;
      }
      case "env":
        // No `decrypt`: values are not asked for. parseEnv drops them even if the answer carries one.
        out = { vars: parseEnv(await go("filter_project_envs", { idOrName: link.projectId })) };
        break;
      case "buildlog": {
        const id = opts.deployment ?? "";
        if (!VERCEL_DEPLOYMENT_PATTERN.test(id)) throw fail("failed");
        // The deployment must belong to the linked project: another project of the same team is not this tab's to read.
        if (deploymentProjectId(await go("get_deployment", { idOrUrl: id })) !== link.projectId) throw fail("no_access");
        const events = await go("list_deployment_events", { idOrUrl: id, direction: "backward", limit: 300 });
        out = { lines: parseBuildLog(isObj(events) ? { events: arr(events.events).reverse() } : events, opts.errorsOnly === true) };
        break;
      }
    }
    return out as VercelSectionData[S];
  }
}
