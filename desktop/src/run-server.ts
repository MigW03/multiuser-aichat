import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { extname } from "node:path";
import { FolderError, locate, openFile } from "./folder-fs.ts";
import { resolve, type Item } from "./folder-items.ts";

// "Run page": serves what this person shares from their own disk so an HTML page they share can run in the preview's
// browser view with its scripts, styles and pictures. Security notes for audits are in docs/security-notes.md; the rules:
//  - listens on 127.0.0.1 only, on a random port, and only while a page is running (`stop()` when the view closes);
//  - every address starts with a random token that only the app and the view it opens know (`/<token>/<item>/<path>`), the
//    Host header must be this very address, so a web page elsewhere cannot guess its way in (DNS rebinding included);
//  - GET and HEAD only; a path goes through the same walk as every other read of a shared folder (`locate`): inside an
//    approved item, no "..", no symlinks, secrets/keys/.git/build output hidden, files that change between check and open refused;
//  - every answer carries a Content-Security-Policy that lets the page use only this server (scripts, styles, pictures,
//    fonts, requests): a page cannot send what it reads to the internet. The view also blocks network at the session level
//    (see preview.ts), because a policy header alone does not cover everything (navigation, WebRTC);
//  - errors never say anything about paths on this computer.

/** Largest file served, in bytes. */
export const RUN_MAX_BYTES = 25 * 1024 * 1024;

/** What a running page may load: itself and nothing else. */
export const RUN_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'self'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export const contentTypeOf = (path: string) => TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

const HEADERS = {
  "content-security-policy": RUN_CSP,
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
};

export type RunServer = {
  /** Where the items of a project are read from. Set once by the folder host. */
  setItems(items: (projectId: string) => Item[]): void;
  /** The address of a shared path (like `my-app/site/index.html`), starting the server if it is not running. */
  urlFor(projectId: string, path: string): Promise<string>;
  /** Whether an address belongs to this server and carries a token it handed out. */
  owns(url: string): boolean;
  /** The origin ("http://127.0.0.1:port") while running, else null. */
  origin(): string | null;
  /** Stops the server and forgets every token. */
  stop(): void;
};

export function createRunServer(): RunServer {
  let getItems: (projectId: string) => Item[] = () => [];
  let server: Server | null = null;
  let starting: Promise<Server> | null = null;
  let host = "";
  const tokens = new Map<string, string>(); // token -> project id

  const fail = (res: ServerResponse, status: number, text: string) => {
    res.writeHead(status, { ...HEADERS, "content-type": "text/plain; charset=utf-8" });
    res.end(text);
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "Method not allowed");
    if (req.headers.host !== host) return fail(res, 403, "Forbidden");
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", `http://${host}`).pathname;
    } catch {
      return fail(res, 400, "Bad request");
    }
    const [, token = "", ...rest] = pathname.split("/");
    const projectId = tokens.get(token);
    if (!projectId) return fail(res, 404, "Not found");
    try {
      const path = rest.map((s) => decodeURIComponent(s)).join("/");
      const t = resolve(getItems(projectId), path.replace(/\/+$/, ""));
      if (t === "top") throw new FolderError("not_found", "Not found");
      let found = await locate(t.root, t.start.join("/"));
      if (found.isDir) {
        if (t.single) throw new FolderError("not_found", "Not found");
        found = await locate(t.root, [...t.start, "index.html"].join("/"));
        if (found.isDir) throw new FolderError("not_found", "Not found");
      }
      if (found.size > RUN_MAX_BYTES) throw new FolderError("too_large", "Too large");
      const handle = await openFile(found);
      let body: Buffer;
      try {
        body = await handle.readFile();
      } finally {
        await handle.close().catch(() => undefined);
      }
      if (body.length > RUN_MAX_BYTES) throw new FolderError("too_large", "Too large");
      res.writeHead(200, { ...HEADERS, "content-type": contentTypeOf(found.abs), "content-length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (e) {
      if (e instanceof FolderError) return fail(res, e.code === "too_large" ? 413 : 404, e.code === "too_large" ? "Too large" : "Not found");
      if (e instanceof URIError) return fail(res, 400, "Bad request");
      console.error("[run] request failed:", e instanceof Error ? e.message : e);
      fail(res, 500, "Failed");
    }
  }

  function start(): Promise<Server> {
    if (server) return Promise.resolve(server);
    starting ??= new Promise<Server>((ok, bad) => {
      const s = createServer((req, res) => void handle(req, res));
      s.on("error", bad);
      s.listen(0, "127.0.0.1", () => {
        host = `127.0.0.1:${(s.address() as AddressInfo).port}`;
        server = s;
        starting = null;
        ok(s);
      });
    });
    return starting;
  }

  const encode = (path: string) => path.split("/").map(encodeURIComponent).join("/");

  return {
    setItems: (fn) => {
      getItems = fn;
    },
    async urlFor(projectId, path) {
      await start();
      let token = [...tokens].find(([, p]) => p === projectId)?.[0];
      if (!token) {
        token = randomBytes(24).toString("base64url");
        tokens.set(token, projectId);
      }
      return `http://${host}/${token}/${encode(path)}`;
    },
    owns(url) {
      if (!server) return false;
      try {
        const u = new URL(url);
        return u.protocol === "http:" && u.host === host && tokens.has(u.pathname.split("/")[1] ?? "");
      } catch {
        return false;
      }
    },
    origin: () => (server ? `http://${host}` : null),
    stop() {
      const s = server;
      server = null;
      starting = null;
      tokens.clear();
      host = "";
      if (!s) return;
      s.close();
      s.closeAllConnections();
    },
  };
}
