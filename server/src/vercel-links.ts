import type { Role, VercelLink } from "@mc/shared";
import { admin } from "./supabase.ts";

// project_vercel_links has RLS on and no client grants (migration 0023): only this server reads or writes it. The link
// holds public facts only (the Vercel team's id and short name, the project's id and name).

export type VercelLinkStore = {
  get: (projectId: string) => Promise<VercelLink | null>;
  /** The database function checks that the person is the host or an admin. A failure comes back as its short code. */
  set: (userId: string, projectId: string, link: { teamId: string; teamSlug: string; projectId: string; name: string }) => Promise<{ error: string } | null>;
  remove: (userId: string, projectId: string) => Promise<{ error: string } | null>;
  /** The person's role in the project, or null when they are not in it. */
  roleOf: (userId: string, projectId: string) => Promise<Role | null>;
};

export const vercelLinkStore: VercelLinkStore = {
  async get(projectId) {
    const { data, error } = await admin.from("project_vercel_links").select("vercel_team_id, vercel_team_slug, vercel_project_id, name, linked_by, linked_at").eq("project_id", projectId).maybeSingle();
    if (error) throw new Error(error.message);
    return data
      ? { teamId: data.vercel_team_id as string, teamSlug: data.vercel_team_slug as string, projectId: data.vercel_project_id as string, name: data.name as string, linked_by: (data.linked_by as string | null) ?? null, linked_at: data.linked_at as string }
      : null;
  },
  async set(userId, projectId, link) {
    const { error } = await admin.rpc("app_vercel_link_set", { p_user: userId, p_project: projectId, p_team: link.teamId, p_team_slug: link.teamSlug, p_vercel_project: link.projectId, p_name: link.name });
    return error ? { error: error.message } : null;
  },
  async remove(userId, projectId) {
    const { error } = await admin.rpc("app_vercel_link_remove", { p_user: userId, p_project: projectId });
    return error ? { error: error.message } : null;
  },
  async roleOf(userId, projectId) {
    const { data, error } = await admin.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.role as Role | undefined) ?? null;
  },
};
