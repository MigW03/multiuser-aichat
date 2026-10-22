import { isVercelMcpUrl } from "./vercel.ts";

// Some hosted MCP servers offer far more tools than a Nido project needs (Vercel: 239). For the ones listed here, Nido
// offers the AI only the tools below, unless the person switches on "All tools" for that server. A server not listed
// here offers everything, as before.

export type McpPreset = {
  /** Shown in Settings: "Nido picks 12 of 239". */
  label: string;
  tools: ReadonlySet<string>;
};

/** What people check while building on Vercel: look at deployments, build logs, errors, domains and variable names, and read the docs.
 *  Nido's MCP has no approval step for a tool that changes something, so the tools that change Vercel (redeploy, promote,
 *  roll back, domains, project settings) are NOT in the preset, nor are env writes, DNS, buying domains, firewall, pausing,
 *  tokens, drains, sandboxes, flags, Edge Config, KMS, billing and CI. A person who wants them can switch on "All tools". */
export const VERCEL_PRESET_TOOLS = [
  // look (the Vercel tab reads only these)
  "list_teams",
  "list_projects",
  "get_project",
  "list_deployments",
  "get_deployment",
  "list_deployment_events",
  "get_runtime_errors",
  "get_runtime_logs",
  "list_project_domains",
  "get_domain_config",
  "filter_project_envs",
  // docs
  "search_vercel_documentation",
] as const;

const VERCEL: McpPreset = { label: "Vercel", tools: new Set(VERCEL_PRESET_TOOLS) };

/** The preset for a server address, or null when Nido has none for it. */
export function mcpPresetFor(url: string): McpPreset | null {
  return isVercelMcpUrl(url) ? VERCEL : null;
}
