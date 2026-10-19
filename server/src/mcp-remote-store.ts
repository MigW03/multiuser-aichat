import { admin } from "./supabase.ts";

// user_mcp_servers has RLS on and no client grants: only this server reads or writes it (see migration 0014). Secrets in
// it are encrypted before they get here; this file never sees a plaintext secret except in what its callers pass in.

export type RemoteRow = {
  id: string;
  user_id: string;
  name: string;
  url: string;
  auth_kind: "none" | "header" | "oauth";
  header_name: string | null;
  secret_enc: string | null;
  secret_hint: string | null;
  oauth_enc: string | null;
  oauth_state: string | null;
  oauth_state_expires: string | null;
  enabled: boolean;
  disabled_tools: string[];
  created_at: string;
};

export type RemoteStore = {
  list: (userId: string) => Promise<RemoteRow[]>;
  get: (userId: string, id: string) => Promise<RemoteRow | null>;
  byState: (state: string) => Promise<RemoteRow | null>;
  insert: (row: Omit<RemoteRow, "id" | "created_at" | "oauth_state" | "oauth_state_expires" | "oauth_enc" | "enabled" | "disabled_tools"> & { oauth_enc?: string | null }) => Promise<RemoteRow>;
  update: (userId: string, id: string, patch: Partial<Omit<RemoteRow, "id" | "user_id" | "created_at">>) => Promise<RemoteRow | null>;
  remove: (userId: string, id: string) => Promise<boolean>;
};

export class StoreError extends Error {
  constructor(readonly code: "too_many" | "name_taken" | "failed") {
    super(code);
  }
}

export const supabaseRemoteStore: RemoteStore = {
  async list(userId) {
    const { data, error } = await admin.from("user_mcp_servers").select("*").eq("user_id", userId).order("created_at");
    if (error) throw new StoreError("failed");
    return (data ?? []) as RemoteRow[];
  },
  async get(userId, id) {
    const { data, error } = await admin.from("user_mcp_servers").select("*").eq("user_id", userId).eq("id", id).maybeSingle();
    if (error) throw new StoreError("failed");
    return (data as RemoteRow | null) ?? null;
  },
  async byState(state) {
    const { data, error } = await admin.from("user_mcp_servers").select("*").eq("oauth_state", state).maybeSingle();
    if (error) throw new StoreError("failed");
    return (data as RemoteRow | null) ?? null;
  },
  async insert(row) {
    const { data, error } = await admin.from("user_mcp_servers").insert(row).select("*").single();
    if (error) {
      if (error.message.includes("too_many_servers")) throw new StoreError("too_many");
      if (error.code === "23505") throw new StoreError("name_taken");
      console.error("[mcp-remote] insert failed:", error.message);
      throw new StoreError("failed");
    }
    return data as RemoteRow;
  },
  async update(userId, id, patch) {
    const { data, error } = await admin.from("user_mcp_servers").update(patch).eq("user_id", userId).eq("id", id).select("*").maybeSingle();
    if (error) {
      console.error("[mcp-remote] update failed:", error.message);
      throw new StoreError("failed");
    }
    return (data as RemoteRow | null) ?? null;
  },
  async remove(userId, id) {
    const { data, error } = await admin.from("user_mcp_servers").delete().eq("user_id", userId).eq("id", id).select("id");
    if (error) throw new StoreError("failed");
    return (data ?? []).length > 0;
  },
};
