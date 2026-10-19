import { decrypt, encrypt } from "./crypto.ts";
import { env } from "./env.ts";
import { RemoteMcp } from "./mcp-remote.ts";
import { supabaseRemoteStore } from "./mcp-remote-store.ts";
import { guardedFetch } from "./ssrf.ts";

// Remote MCP servers, wired to the database, the key encryption and the guarded fetch.
export const remoteDeps = { store: supabaseRemoteStore, encrypt, decrypt, serverUrl: env.serverUrl, fetch: guardedFetch };
export const remoteMcp = new RemoteMcp(remoteDeps);
