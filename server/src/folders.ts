import { userIdFor } from "./auth.ts";
import { createRelay } from "./folder-relay.ts";
import { admin } from "./supabase.ts";

// The shared-folder relay, wired to Supabase: who the host is, which project a folder belongs to, who may read it.

export const relay = createRelay({
  authenticate: (token) => userIdFor(token),

  async hostCheck(userId, projectId) {
    const { data, error } = await admin.rpc("app_folder_host_check", { p_user: userId, p_project: projectId });
    if (!error && typeof data === "string") return { ok: true, name: data };
    if (error?.message.trim() === "forbidden") return { ok: false, reason: "not_host" };
    if (error?.message.trim() === "not_linked") return { ok: false, reason: "not_linked" };
    throw new Error(error?.message ?? "host check failed"); // a database problem, not an answer
  },

  async setOnline(projectId, online) {
    const { error } = await admin.rpc("app_folder_set_online", { p_project: projectId, p_online: online });
    if (error) throw new Error(error.message);
  },
});

export type FolderAccess = { ok: true; name: string } | { ok: false; reason: "not_found" | "not_linked" };

/** Whether `userId` belongs to the project and a folder is shared in it. This is the permission check for every read. */
export async function folderAccess(userId: string, projectId: string): Promise<FolderAccess> {
  const { data, error } = await admin.rpc("app_folder_member_check", { p_user: userId, p_project: projectId });
  if (!error && typeof data === "string") return { ok: true, name: data };
  if (error?.message.trim() === "not_linked") return { ok: false, reason: "not_linked" };
  if (error && error.message.trim() !== "not_found") console.error("[folder] access check failed:", error.message);
  return { ok: false, reason: "not_found" };
}

/** After a restart no host app is connected yet, whatever the table says. */
export async function resetFolderStatus(): Promise<void> {
  const { error } = await admin.rpc("app_folders_all_offline");
  if (error) console.error("[folder] could not reset folder status:", error.message);
}
