import type { Role, SupabaseLink } from "@mc/shared";
import { admin } from "./supabase.ts";

// project_supabase_links has RLS on and no client grants (migration 0022): only this server reads or writes it. The link
// holds public facts only (the Supabase project's reference, name and region).

export type LinkStore = {
  get: (projectId: string) => Promise<SupabaseLink | null>;
  /** The database function checks that the person is the host or an admin. A failure comes back as its short code. */
  set: (userId: string, projectId: string, link: { ref: string; name: string; region: string }) => Promise<{ error: string } | null>;
  remove: (userId: string, projectId: string) => Promise<{ error: string } | null>;
  /** The person's role in the project, or null when they are not in it. */
  roleOf: (userId: string, projectId: string) => Promise<Role | null>;
};

export const supabaseLinkStore: LinkStore = {
  async get(projectId) {
    const { data, error } = await admin.from("project_supabase_links").select("supabase_ref, name, region, linked_by, linked_at").eq("project_id", projectId).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? { ref: data.supabase_ref as string, name: data.name as string, region: data.region as string, linked_by: (data.linked_by as string | null) ?? null, linked_at: data.linked_at as string } : null;
  },
  async set(userId, projectId, link) {
    const { error } = await admin.rpc("app_supabase_link_set", { p_user: userId, p_project: projectId, p_ref: link.ref, p_name: link.name, p_region: link.region });
    return error ? { error: error.message } : null;
  },
  async remove(userId, projectId) {
    const { error } = await admin.rpc("app_supabase_link_remove", { p_user: userId, p_project: projectId });
    return error ? { error: error.message } : null;
  },
  async roleOf(userId, projectId) {
    const { data, error } = await admin.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.role as Role | undefined) ?? null;
  },
};
