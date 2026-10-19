import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

// A small MCP server over HTTP for tests, with the three kinds of sign-in the app supports: none, a header, and OAuth.

export type Fixture = {
  url: string;
  origin: string;
  server: Server;
  /** Requests that reached /mcp, with the Authorization header and the custom header seen. */
  seen: { auth?: string; key?: string }[];
  /** OAuth: the codes the /authorize step would have handed out, and the tokens handed out so far. */
  tokens: string[];
  registrations: number;
  close: () => Promise<void>;
};

function mcpServer() {
  const s = new McpServer({ name: "remote-fake", version: "1.0.0" });
  s.registerTool("echo", { description: "Echo text back.", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }));
  s.registerTool("big", { description: "A very long answer." }, async () => ({ content: [{ type: "text", text: "x".repeat(80_000) }] }));
  s.registerTool("boom", { description: "Always fails." }, async () => ({ isError: true, content: [{ type: "text", text: "it broke" }] }));
  s.registerTool("slow", { description: "Never answers in time." }, async () => {
    await new Promise((r) => setTimeout(r, 30_000));
    return { content: [] };
  });
  return s;
}

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });

export async function startFixture(opts: { auth?: "none" | "header" | "oauth"; headerName?: string; secret?: string } = {}): Promise<Fixture> {
  const kind = opts.auth ?? "none";
  const headerName = (opts.headerName ?? "x-api-key").toLowerCase();
  const secret = opts.secret ?? "s3cret";
  const fx = { seen: [] as Fixture["seen"], tokens: [] as string[], registrations: 0 };
  let origin = "";
  const json = (res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(data));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.startsWith("/.well-known/openid-configuration"))
      return json(res, 200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (url.pathname === "/register") {
      fx.registrations++;
      const meta = JSON.parse(await body(req));
      return json(res, 201, { ...meta, client_id: "client-1" });
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(await body(req));
      if (params.get("grant_type") === "authorization_code" && params.get("code") === "good-code" && params.get("code_verifier")) {
        const t = `access-${fx.tokens.length + 1}`;
        fx.tokens.push(t);
        return json(res, 200, { access_token: t, token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600 });
      }
      if (params.get("grant_type") === "refresh_token" && params.get("refresh_token") === "refresh-1") {
        const t = `access-${fx.tokens.length + 1}`;
        fx.tokens.push(t);
        return json(res, 200, { access_token: t, token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600 });
      }
      return json(res, 400, { error: "invalid_grant" });
    }
    if (url.pathname === "/mcp") {
      const auth = req.headers.authorization;
      const key = req.headers[headerName] as string | undefined;
      fx.seen.push({ ...(auth ? { auth } : {}), ...(key ? { key } : {}) });
      if (kind === "header" && key !== secret) return json(res, 401, { error: "bad key" });
      if (kind === "oauth" && !(auth && fx.tokens.includes(auth.replace(/^Bearer /, "")))) return json(res, 401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });
      const raw = await body(req);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const s = mcpServer();
      res.on("close", () => void transport.close().then(() => s.close()));
      await s.connect(transport);
      return void (await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    server,
    seen: fx.seen,
    tokens: fx.tokens,
    get registrations() {
      return fx.registrations;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  } as Fixture;
}
