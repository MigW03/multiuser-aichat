import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { requireUser, type AuthVars } from "./auth.ts";
import { env } from "./env.ts";
import { relay, resetFolderStatus } from "./folders.ts";
import { chats, messages } from "./routes/chats.ts";
import { folder } from "./routes/folder.ts";
import { invites, publicInvites } from "./routes/invites.ts";
import { keys } from "./routes/keys.ts";
import { projects } from "./routes/projects.ts";
import { recoverRuns } from "./run-queue.ts";

const app = new Hono<AuthVars>();

app.use(secureHeaders());
// Auth is a bearer token, not a cookie, so CORS isn't what protects the API; it only keeps other sites from using it in a browser.
app.use("/api/*", cors({ origin: env.allowedOrigins, allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }));
app.use("/api/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }));

app.get("/health", (c) => c.json({ ok: true }));

// The only route that works signed out: the join page previews an invite before there is an account.
// It must be registered before the auth middleware below.
app.route("/api/invites", publicInvites);

app.use("/api/*", requireUser);
app.route("/api", keys);
app.route("/api/projects", projects);
app.route("/api/projects", folder);
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
  void resetFolderStatus();
});
// Host desktop apps connect over a WebSocket (/api/folder-host); everything else here is plain HTTP.
relay.attach(server as import("node:http").Server);
