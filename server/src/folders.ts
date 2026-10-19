import { userIdFor } from "./auth.ts";
import { createHub, type Share } from "./folder-hub.ts";
import { createRelay } from "./folder-relay.ts";
import { admin } from "./supabase.ts";

// The shared-files relay and hub, wired to Supabase: who may connect, which items each owner shares and whether they were
// approved, and who may read.

async function loadShares(projectId: string): Promise<Share[]> {
  const { data, error } = await admin.from("project_shares").select("id, owner_id, item_key, name, kind, status").eq("project_id", projectId);
  if (error) throw new Error(error.message);
  return (data ?? []) as Share[];
}

export const relay = createRelay({
  authenticate: (token) => userIdFor(token),

  async connectCheck(userId, projectId) {
    const { error } = await admin.rpc("app_share_connect", { p_user: userId, p_project: projectId });
    if (!error) return { ok: true };
    if (error.message.trim() === "not_found") return { ok: false, reason: "not_found" };
    throw new Error(error.message); // a database problem, not an answer
  },

  async sync(userId, projectId, items) {
    const { data, error } = await admin.rpc("app_share_sync", { p_user: userId, p_project: projectId, p_items: items });
    if (error) throw new Error(["too_many", "invalid_items", "not_found"].includes(error.message.trim()) ? error.message.trim() : "failed");
    return (data ?? []) as { key: string; name: string; status: "pending" | "active" }[];
  },

  async setOnline(projectId, ownerId, online) {
    const { error } = await admin.rpc("app_share_set_online", { p_project: projectId, p_owner: ownerId, p_online: online });
    if (error) throw new Error(error.message);
  },

  changed: (projectId) => hub.invalidate(projectId),
});

export const hub = createHub(relay, { loadShares });

export type FolderAccess = { ok: true; name: string } | { ok: false; reason: "not_found" | "not_linked" };

/** Whether `userId` belongs to the project and at least one item is approved. This is the permission check for every read. `name` lists the approved items. */
export async function folderAccess(userId: string, projectId: string): Promise<FolderAccess> {
  const { error } = await admin.rpc("app_share_member_check", { p_user: userId, p_project: projectId });
  if (error?.message.trim() === "not_linked") return { ok: false, reason: "not_linked" };
  if (error) {
    if (error.message.trim() !== "not_found") console.error("[folder] access check failed:", error.message);
    return { ok: false, reason: "not_found" };
  }
  const names = (await loadShares(projectId).catch(() => [])).filter((s) => s.status === "active").map((s) => s.name);
  return { ok: true, name: names.join(", ") };
}

/** After a restart no app is connected yet, whatever the table says. */
export async function resetFolderStatus(): Promise<void> {
  const { error } = await admin.rpc("app_shares_all_offline");
  if (error) console.error("[folder] could not reset sharing status:", error.message);
}

/** Tells an owner's app what the project calls its items now, after an approval, a decline or a removal. */
export async function pushOwnerItems(projectId: string, ownerId: string): Promise<void> {
  hub.invalidate(projectId);
  relay.pushItems(projectId, ownerId, await hub.itemsOf(projectId, ownerId));
}
