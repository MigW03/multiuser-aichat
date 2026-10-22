import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { IMAGE_LIMITS } from "@mc/shared";
import { requireUser, type AuthVars } from "./auth.ts";
import { env } from "./env.ts";
import { sweepUnsentImages } from "./images.ts";
import { relay, resetFolderStatus } from "./folders.ts";
import { MCP_PATH } from "./mcp-relay.ts";
import { mcpRelay } from "./mcp.ts";
import { chats, messages } from "./routes/chats.ts";
import { folder } from "./routes/folder.ts";
import { invites, publicInvites } from "./routes/invites.ts";
import { keys } from "./routes/keys.ts";
import { notes } from "./routes/notes.ts";
import { mcpOauthPublic, mcpServers } from "./routes/mcp.ts";
import { projects } from "./routes/projects.ts";
import { smart } from "./routes/smart.ts";
import { supabase } from "./routes/supabase.ts";
import { recoverRuns } from "./run-queue.ts";

const app = new Hono<AuthVars>();

app.use(secureHeaders());
// Auth is a bearer token, not a cookie, so CORS isn't what protects the API; it only keeps other sites from using it in a browser.
app.use("/api/*", cors({ origin: env.allowedOrigins, allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }));
const smallBody = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) });
// Picture uploads send the file itself as the body; this is the only route allowed a big one.
const pictureBody = bodyLimit({ maxSize: IMAGE_LIMITS.bytes + 1024, onError: (c) => c.json({ error: "That picture is over 5 MB." }, 413) });
app.use("/api/*", (c, next) => (c.req.method === "POST" && /^\/api\/chats\/[^/]+\/images$/.test(c.req.path) ? pictureBody(c, next) : smallBody(c, next)));

app.get("/health", (c) => c.json({ ok: true }));

// The only route that works signed out: the join page previews an invite before there is an account.
// It must be registered before the auth middleware below.
app.route("/api/invites", publicInvites);
// The OAuth provider's redirect for remote MCP servers is a browser navigation without our token; its single-use state is the proof.
app.route("/api/mcp/oauth", mcpOauthPublic);

app.use("/api/*", requireUser);
app.route("/api", keys);
app.route("/api", smart);
app.route("/api/projects", projects);
app.route("/api/projects", folder);
app.route("/api/projects", notes);
app.route("/api/projects", supabase);
app.route("/api/mcp", mcpServers);
app.route("/api/chats", chats);
app.route("/api/messages", messages);
app.route("/api/invites", invites);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error("[server]", err);
  return c.json({ error: "Something went wrong" }, 500);
});

const server = serve({ fetch: app.fetch, port: env.port, hostname: process.env.HOST ?? "127.0.0.1" }, (info) => {
  console.log(`server listening on http://${info.address}:${info.port}`);
  void recoverRuns();
  // Pictures uploaded and never sent are removed after an hour.
  const sweep = () => void sweepUnsentImages().catch((e) => console.error("[images] sweep failed:", e));
  sweep();
  setInterval(sweep, 15 * 60_000).unref();
  void resetFolderStatus();
});
// Desktop apps connect over WebSockets: /api/folder-host (a project host's shared folder) and /api/mcp-host (a person's
// connected tools). Everything else here is plain HTTP.
relay.attach(server as import("node:http").Server, (path) => path === MCP_PATH);
mcpRelay.attach(server as import("node:http").Server);
