import type { VercelSectionData } from "@mc/shared";

// Small rules for how the Vercel tab shows what Vercel says.

/** "3 min ago", "2 h ago", "4 d ago". */
export function ago(iso: string | null, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** The colour of a deployment state: the same dots as the MCP status. */
export function stateDot(state: string): "ready" | "failed" | "signin" | "off" {
  if (state === "READY") return "ready";
  if (state === "ERROR") return "failed";
  if (state === "BUILDING" || state === "QUEUED" || state === "INITIALIZING") return "signin"; // yellow
  return "off";
}

/** The dot on the Vercel tab: red when the latest production build failed, yellow while one is building. */
export function vercelTabDot(o: VercelSectionData["overview"] | null): "failed" | "signin" | null {
  const dot = o?.production ? stateDot(o.production.state) : null;
  return dot === "failed" || dot === "signin" ? dot : null;
}

