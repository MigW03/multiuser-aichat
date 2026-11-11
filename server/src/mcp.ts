import { userIdFor } from "./auth.ts";
import { registerClaudeCode } from "./claude-code.ts";
import { createMcpRelay } from "./mcp-relay.ts";

// The connected-tools relay, wired to sign-in: a desktop app proves who it is with the person's Supabase access token.
export const mcpRelay = createMcpRelay({ authenticate: (token) => userIdFor(token) });
registerClaudeCode({ ready: (userId) => mcpRelay.claudeCodeReady(userId), run: (userId, req, signal) => mcpRelay.claudeCode(userId, req, signal) });
