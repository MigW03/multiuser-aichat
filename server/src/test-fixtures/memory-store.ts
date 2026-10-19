import { randomUUID } from "node:crypto";
import { StoreError, type RemoteRow, type RemoteStore } from "../mcp-remote-store.ts";

// "Encryption" for tests: reversible, and obviously not plaintext, so a test can check no secret is stored in the clear.
export const encrypt = (s: string) => `enc:${Buffer.from(s).toString("base64")}`;
export const decrypt = (s: string) => Buffer.from(s.replace(/^enc:/, ""), "base64").toString();

export function memoryStore(): RemoteStore & { rows: Map<string, RemoteRow> } {
  const rows = new Map<string, RemoteRow>();
  return {
    rows,
    // Copies, like a database: a row someone holds does not change under them.
    list: async (u) => [...rows.values()].filter((r) => r.user_id === u).map((r) => ({ ...r })),
    get: async (u, id) => (rows.get(id)?.user_id === u ? { ...rows.get(id)! } : null),
    byState: async (s) => {
      const r = [...rows.values()].find((x) => x.oauth_state === s);
      return r ? { ...r } : null;
    },
    insert: async (r) => {
      if ([...rows.values()].some((x) => x.user_id === r.user_id && x.name === r.name)) throw new StoreError("name_taken");
      if ([...rows.values()].filter((x) => x.user_id === r.user_id).length >= 10) throw new StoreError("too_many");
      const row: RemoteRow = { oauth_enc: null, oauth_state: null, oauth_state_expires: null, enabled: true, disabled_tools: [], created_at: new Date().toISOString(), ...r, id: randomUUID() };
      rows.set(row.id, row);
      return { ...row };
    },
    update: async (u, id, patch) => {
      const r = rows.get(id);
      if (!r || r.user_id !== u) return null;
      Object.assign(r, patch);
      return { ...r };
    },
    remove: async (u, id) => rows.get(id)?.user_id === u && rows.delete(id),
  };
}

