// The Vercel tab of the Files card: a Nido project is linked to one Vercel project; each person looks at it through their
// own Vercel connection (the hosted Vercel MCP server in their MCP servers). Types shared by the chat server and the
// page, and the small rules both apply. Nothing here ever holds an environment variable's value.

export const VERCEL_MCP_HOST = "mcp.vercel.com";
/** What "Connect Vercel" adds to a person's MCP servers: the hosted server. */
export const VERCEL_MCP_URL = `https://${VERCEL_MCP_HOST}/`;
/** Vercel ids: a team, a project and a deployment. */
export const VERCEL_TEAM_PATTERN = /^team_[A-Za-z0-9]{10,40}$/;
export const VERCEL_PROJECT_PATTERN = /^prj_[A-Za-z0-9]{10,40}$/;
export const VERCEL_DEPLOYMENT_PATTERN = /^dpl_[A-Za-z0-9]{10,40}$/;
/** A team's short name in Vercel's addresses. */
export const VERCEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Whether an MCP server address is the hosted Vercel one. Only the host counts, not the path or the query. */
export function isVercelMcpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.toLowerCase() === VERCEL_MCP_HOST && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** The link between a Nido project and a Vercel project. Public facts only: no tokens, no secrets. */
export type VercelLink = { teamId: string; teamSlug: string; projectId: string; name: string; linked_by: string | null; linked_at: string };

/** How this person's own Vercel connection is doing. `none`: no Vercel entry in their MCP servers. */
export type VercelMine = {
  state: "none" | "ready" | "needs_sign_in" | "connecting" | "failed" | "off";
  /** The id of their Vercel entry in the MCP servers, when there is one (for Sign in). */
  serverId?: string;
  error?: string;
};

export type VercelState = {
  link: VercelLink | null;
  mine: VercelMine;
  /** The host and admins link, change and unlink. */
  canLink: boolean;
  /** False when this chat server has no public address, so a Vercel sign-in cannot work. */
  oauthAvailable: boolean;
};

/** The Files card shows the Vercel tab only for a linked project, and only to someone who has set Vercel up. */
export function showVercelTab(state: Pick<VercelState, "link" | "mine"> | null): boolean {
  return !!state && state.link !== null && state.mine.state !== "none";
}

/** One Vercel project in the person's own account, to pick from when linking. */
export type VercelProjectOption = { teamId: string; teamSlug: string; teamName: string; projectId: string; name: string };

export const VERCEL_SECTIONS = ["overview", "deployments", "errors", "logs", "domains", "env", "buildlog"] as const;
export type VercelSection = (typeof VERCEL_SECTIONS)[number];

/** Minutes. Vercel's free plan keeps runtime logs for one hour, so the first window is short. */
export const VERCEL_LOG_WINDOWS = [30, 60, 360, 1440] as const;
export const VERCEL_ERROR_WINDOWS = ["24h", "7d"] as const;

/** One deployment. `state` is Vercel's word (READY, ERROR, BUILDING, QUEUED, INITIALIZING, CANCELED, BLOCKED). */
export type VercelDeployment = {
  id: string;
  state: string;
  target: "production" | "preview";
  branch: string;
  /** First 7 characters of the commit. */
  sha: string;
  /** First line of the commit message. */
  message: string;
  author: string;
  createdAt: string | null;
  /** The deployment's own address, host only. */
  host: string;
  /** Vercel's page for this deployment, when it is on vercel.com. */
  inspectorUrl: string | null;
};
export type VercelOverview = {
  name: string;
  framework: string;
  node: string;
  /** "owner/repo" of the connected Git repository. */
  repo: string;
  /** The latest production deployment. */
  production: VercelDeployment | null;
  /** The main address people reach the project at, when there is one. */
  domain: string | null;
};
export type VercelErrorsData = { none: boolean; lines: string[] };
export type VercelLogsData = { lines: string[] };
export type VercelDomain = { name: string; verified: boolean; redirect: string | null; /** False when Vercel says the DNS is not set up for it. Null when unknown. */ configured: boolean | null };
/** One variable: its NAME and where it applies. Never its value. */
export type VercelEnvVar = { key: string; targets: string[]; type: string; updatedAt: string | null };
export type VercelBuildLine = { time: string | null; text: string; level: "info" | "error" };

export type VercelSectionData = {
  overview: VercelOverview;
  deployments: { deployments: VercelDeployment[] };
  errors: VercelErrorsData;
  logs: VercelLogsData;
  domains: { domains: VercelDomain[] };
  env: { vars: VercelEnvVar[] };
  buildlog: { lines: VercelBuildLine[] };
};

/** Why a section could not be read, in words the page can act on. `window`: the plan does not keep logs that far back. */
export type VercelFailure = "needs_sign_in" | "no_access" | "busy" | "unavailable" | "window" | "failed";
