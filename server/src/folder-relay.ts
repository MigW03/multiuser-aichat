import { FOLDER_LIMITS as L, type ChangePreview, type FolderCaps, type FolderErrorCode, type FolderGlobResult, type FolderListResult, type FolderReadResult, type FolderSearchResult, type ExecResult, type GitChangeResult, type GitStatusResult, type GitTextResult } from "@mc/shared";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

// The relay for shared folders. Each person who shares files in a project (the host, admins, members whose requests were
// approved) runs the desktop app, which opens a WebSocket here and stays connected. When a project member (or the AI
// answering one) asks to list, read or search, the hub (folder-hub.ts) checks that they belong to the project, picks the
// owner whose item the path points into, and passes the request down that owner's socket. File contents only ever pass
// through memory: nothing is stored, and nothing is cached.
//
// An owner's app is a client like any other and is not trusted with more than answering: every answer is validated
// and size-limited before it goes on to a member or the AI. Which items an owner may serve is decided by the database,
// never by what the app claims.

/** What an app reports for each thing it shares: its own random id for it (never a path), a suggested name, folder or file. */
export type ShareItemIn = { key: string; name: string; kind: "dir" | "file" };
/** What the project calls an item, and whether the host or an admin has approved it yet. */
export type ShareItemOut = { key: string; name: string; status: "pending" | "active" };

export type RelayDeps = {
  /** The user id for a Supabase access token, or null. */
  authenticate: (token: string) => Promise<string | null>;
  /** Whether `userId` belongs to `projectId`. Any member may connect; what they may serve is decided by `sync`. */
  connectCheck: (userId: string, projectId: string) => Promise<{ ok: true } | { ok: false; reason: "not_found" }>;
  /** Records everything this owner shares and returns what the project calls each item. Rejects with an Error whose message is a short code (`too_many`, `invalid_items`). */
  sync: (userId: string, projectId: string, items: ShareItemIn[]) => Promise<ShareItemOut[]>;
  setOnline: (projectId: string, ownerId: string, online: boolean) => Promise<void>;
  /** An owner's connection or items changed: what the project can read may have changed with it. */
  changed?: (projectId: string, ownerId: string) => void;
};

/** `offline`: no host app connected. `host`: the host's app refused or failed, with a message written to be shown. */
export class RelayError extends Error {
  constructor(
    readonly kind: "offline" | "busy" | "timeout" | "host" | "bad_answer" | "cancelled",
    message: string,
    readonly code?: FolderErrorCode,
  ) {
    super(message);
  }
}

export type RelayRequest =
  | { op: "list"; path: string }
  | { op: "read"; path: string; offset?: number; limit?: number }
  | { op: "glob"; pattern: string; path?: string; hidden?: boolean; limit?: number }
  | { op: "grep"; pattern: string; path?: string; include?: string; literal?: boolean; caseSensitive?: boolean; limit?: number }
  | { op: "edit"; path: string; oldString: string; newString: string; replaceAll?: boolean; askedBy: string; readFiles: number }
  | { op: "write"; path: string; content: string; hadRead: boolean; askedBy: string; readFiles: number }
  | { op: "git"; sub: "status" }
  | { op: "git"; sub: "diff"; target?: "worktree" | "staged" | "head"; path?: string }
  | { op: "git"; sub: "log"; path?: string; limit?: number }
  | { op: "git"; sub: "show"; rev: string; path?: string }
  | { op: "git_change"; action: "add" | "restore"; paths: string[]; askedBy: string; readFiles: number }
  | { op: "git_change"; action: "commit"; message: string; askedBy: string; readFiles: number }
  | { op: "git_change"; action: "branch"; name: string; askedBy: string; readFiles: number }
  | { op: "exec"; command: string; description?: string; workdir?: string; timeoutSec?: number; askedBy: string; readFiles: number };

/** The host's answer once a proposed change was approved and written. */
export type ChangeResult = { path: string; created: boolean; added: number; removed: number };

export type CallOptions = {
  /** How long to wait for the host's answer. Changes wait for a person, so they get minutes, not seconds. */
  timeoutMs?: number;
  /** Called once when the host's app has the diff ready. */
  onPreview?: (change: ChangePreview) => void;
  /** Aborting withdraws the request from the host's app. */
  signal?: AbortSignal;
};

const uuid = z.uuid();
const itemsIn = z
  .array(z.object({ key: z.string().min(1).max(64), name: z.string().trim().min(1).max(L.nameChars), kind: z.enum(["dir", "file"]) }))
  .max(L.items);
const hello = z.object({ type: z.literal("hello"), token: z.string().min(1).max(4096), projectId: uuid, items: itemsIn });
const itemsMsg = z.object({ type: z.literal("items"), items: itemsIn });
const tokenMsg = z.object({ type: z.literal("token"), token: z.string().min(1).max(4096) });
const capsMsg = z.object({ type: z.literal("caps"), caps: z.object({ edit: z.boolean(), git: z.boolean(), exec: z.boolean() }) });

// eslint-disable-next-line no-control-regex
const clean = (max: number) => z.string().max(max).refine((s) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s), "control characters");
const cleanText = (max: number) => z.string().max(max);
const entry = z.object({ name: clean(255).min(1), type: z.enum(["file", "dir"]), size: z.number().int().nonnegative().optional() });

const changePreview = z.object({
  id: z.string().max(64),
  kind: z.enum(["edit", "write", "git", "exec"]),
  path: clean(L.pathChars),
  command: z.string().max(L.execChars + 100).optional(),
  workdir: clean(L.pathChars).optional(),
  timeoutSec: z.number().int().min(1).max(L.execMaxSec).optional(),
  note: z.string().max(300).optional(),
  destructive: z.boolean().optional(),
  created: z.boolean(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  diff: z.string().max(L.diffChars + 100),
  cut: z.boolean(),
});
const previewMsg = z.object({ type: z.literal("event"), id: z.string().max(64), event: z.literal("pending"), change: changePreview });
const changeDone = z.object({ path: clean(L.pathChars), created: z.boolean(), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() });

const results = {
  edit: changeDone,
  write: changeDone,
  git_change: z.object({ command: z.string().max(1200), output: z.string().max(600) }),
  exec: z.object({
    command: z.string().max(L.execChars + 100),
    exitCode: z.number().int().nullable(),
    signal: z.string().max(20).nullable(),
    timedOut: z.boolean(),
    output: z.string().max(L.execHeadChars + L.execTailChars + 200),
    truncated: z.boolean(),
    ms: z.number().int().nonnegative(),
  }),
  git: z.union([
    z.object({
      branch: clean(120).nullable(),
      files: z.array(z.object({ path: clean(L.pathChars), index: z.string().max(1), worktree: z.string().max(1) })).max(L.gitFiles),
      truncated: z.boolean(),
    }),
    z.object({ text: z.string().max(L.gitChars + 100), truncated: z.boolean() }),
  ]),
  list: z.object({ path: clean(L.pathChars), entries: z.array(entry).max(L.listEntries), truncated: z.boolean() }),
  read: z.object({
    path: clean(L.pathChars),
    text: cleanText(L.readBytes + 4096),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(0),
    totalLines: z.number().int().min(0),
    truncated: z.boolean(),
  }),
  glob: z.object({ paths: z.array(clean(L.pathChars)).max(L.searchLimit), truncated: z.boolean() }),
  grep: z.object({
    matches: z.array(z.object({ path: clean(L.pathChars), line: z.number().int().min(1), text: cleanText(L.searchLineChars + 50) })).max(L.searchLimit),
    truncated: z.boolean(),
  }),
};

const ERROR_CODES = [
  "invalid_path", "not_found", "excluded", "too_large", "binary", "not_a_file", "not_a_directory", "bad_request", "timeout", "busy", "failed",
  "disabled", "no_match", "ambiguous", "secrets", "stale", "denied", "expired", "exists", "no_repo", "git_unsafe", "git_failed", "nothing", "exec_failed",
] as const satisfies readonly FolderErrorCode[];
const response = z.discriminatedUnion("ok", [
  z.object({ id: z.string().max(64), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string().max(64), ok: z.literal(false), code: z.enum(ERROR_CODES), message: clean(300) }),
]);

type Pending = {
  op: RelayRequest["op"];
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onPreview?: (change: ChangePreview) => void;
};

type Conn = {
  ws: WebSocket;
  /** The person whose app this is: the owner of what it serves. */
  userId: string;
  projectId: string;
  pending: Map<string, Pending>;
  /** When changes were last proposed, to keep a flood of proposals from burying the host. */
  proposed: number[];
  /** What the host allows the AI to propose. Nothing until the host's app says so. */
  caps: FolderCaps;
};

const HELLO_MS = 10_000;
const PING_MS = 20_000;
const DEAD_MS = 70_000;
const RECHECK_MS = 5 * 60_000;
const MAX_PENDING = 16;
const MAX_CONNECTIONS = 200;
/** Changes the AI may propose in one project per window. Each one asks the host, so this is a flood limit, not a quota. */
const PROPOSAL_WINDOW_MS = 10 * 60_000;
const MAX_PROPOSALS_PER_WINDOW = 30;
/** Supabase access tokens last an hour and the app sends each refreshed one. A socket whose last token is older than this is closed. */
const TOKEN_MAX_MS = 75 * 60_000;

export function createRelay(deps: RelayDeps, opts: { requestMs?: number; tokenMaxMs?: number; pingMs?: number } = {}) {
  const requestMs = opts.requestMs ?? L.requestMs;
  const tokenMaxMs = opts.tokenMaxMs ?? TOKEN_MAX_MS;
  const pingMs = opts.pingMs ?? PING_MS;
  /** One connection per owner and project. */
  const hosts = new Map<string, Conn>();
  const keyOf = (projectId: string, ownerId: string) => `${projectId}:${ownerId}`;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let open = 0;

  function drop(conn: Conn, why: string) {
    for (const p of conn.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RelayError("offline", why));
    }
    conn.pending.clear();
    if (hosts.get(keyOf(conn.projectId, conn.userId)) === conn) {
      hosts.delete(keyOf(conn.projectId, conn.userId));
      void deps.setOnline(conn.projectId, conn.userId, false).catch((e) => console.error("[folder] could not mark offline:", e));
      deps.changed?.(conn.projectId, conn.userId);
    }
  }

  const send = (ws: WebSocket, msg: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const fail = (ws: WebSocket, code: string, closeCode: number) => {
    send(ws, { type: "error", code });
    ws.close(closeCode, code);
  };

  wss.on("connection", (ws) => {
    open++;
    let conn: Conn | null = null;
    let handling = false;
    let seen = Date.now();
    let authedAt = Date.now();
    const helloTimer = setTimeout(() => ws.close(4408, "hello"), HELLO_MS);
    const ping = setInterval(() => {
      if (Date.now() - seen > DEAD_MS) return void ws.terminate();
      // Signed out elsewhere, or the app stopped refreshing: the connection doesn't outlive its sign-in.
      if (conn && Date.now() - authedAt > tokenMaxMs) return void fail(ws, "unauthorized", 4401);
      send(ws, { type: "ping" });
    }, pingMs);
    const recheck = setInterval(() => {
      if (!conn) return;
      const c = conn;
      void deps.connectCheck(c.userId, c.projectId).then(
        (r) => !r.ok && fail(ws, r.reason, 4403),
        () => undefined, // a database hiccup is not a reason to drop an owner
      );
    }, RECHECK_MS);

    ws.on("pong", () => (seen = Date.now()));
    ws.on("close", () => {
      open--;
      clearTimeout(helloTimer);
      clearInterval(ping);
      clearInterval(recheck);
      if (conn) drop(conn, "The app disconnected.");
    });
    ws.on("error", () => ws.terminate());

    ws.on("message", async (raw, isBinary) => {
      seen = Date.now();
      if (isBinary) return void ws.close(1003, "text only");
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return void ws.close(1008, "bad frame");
      }
      const type = (msg as { type?: unknown } | null)?.type;

      if (!conn) {
        if (handling) return;
        handling = true;
        try {
          const parsed = hello.safeParse(msg);
          if (!parsed.success) return void ws.close(1008, "hello first");
          const userId = await deps.authenticate(parsed.data.token);
          if (!userId) return fail(ws, "unauthorized", 4401);
          const check = await deps.connectCheck(userId, parsed.data.projectId);
          if (!check.ok) return fail(ws, check.reason, 4403);
          let items: ShareItemOut[];
          try {
            items = await deps.sync(userId, parsed.data.projectId, parsed.data.items);
          } catch (e) {
            const code = e instanceof Error && /^[a-z_]{3,30}$/.test(e.message) ? e.message : "failed";
            return fail(ws, code, 4400);
          }
          if (ws.readyState !== ws.OPEN) return;
          clearTimeout(helloTimer);
          authedAt = Date.now();
          const k = keyOf(parsed.data.projectId, userId);
          const previous = hosts.get(k);
          conn = { ws, userId, projectId: parsed.data.projectId, pending: new Map(), proposed: [], caps: { edit: false, git: false, exec: false } };
          hosts.set(k, conn);
          if (previous) {
            // Another copy of this person's app took over: the older one is dropped without marking them offline.
            drop(previous, "The app reconnected.");
            previous.ws.close(4000, "replaced");
          }
          await deps.setOnline(parsed.data.projectId, userId, true);
          send(ws, { type: "ready", items });
          deps.changed?.(parsed.data.projectId, userId);
        } catch (e) {
          console.error("[folder] hello failed:", e instanceof Error ? e.message : e);
          ws.close(1011, "error");
        } finally {
          handling = false;
        }
        return;
      }

      if (type === "res") {
        const parsed = response.safeParse((msg as { res?: unknown }).res);
        if (!parsed.success) return;
        const p = conn.pending.get(parsed.data.id);
        if (!p) return;
        conn.pending.delete(parsed.data.id);
        clearTimeout(p.timer);
        if (!parsed.data.ok) return void p.reject(new RelayError("host", parsed.data.message, parsed.data.code));
        const checked = results[p.op].safeParse(parsed.data.result);
        if (checked.success) p.resolve(checked.data);
        else p.reject(new RelayError("bad_answer", "The app sent an answer that could not be used."));
      } else if (type === "event") {
        const parsed = previewMsg.safeParse(msg);
        const p = parsed.success ? conn.pending.get(parsed.data.id) : undefined;
        // Only for a change that was asked for, once, and about the thing that was asked for.
        if (parsed.success && p?.onPreview && parsed.data.change.id === parsed.data.id) {
          const cb = p.onPreview;
          p.onPreview = undefined;
          cb(parsed.data.change);
        }
      } else if (type === "caps") {
        const parsed = capsMsg.safeParse(msg);
        if (parsed.success) conn.caps = parsed.data.caps;
        deps.changed?.(conn.projectId, conn.userId);
      } else if (type === "items") {
        // The owner picked or removed something: record it and tell the app what the project calls everything now.
        const parsed = itemsMsg.safeParse(msg);
        if (!parsed.success) return;
        const c = conn;
        try {
          send(ws, { type: "items", items: await deps.sync(c.userId, c.projectId, parsed.data.items) });
          deps.changed?.(c.projectId, c.userId);
        } catch (e) {
          send(ws, { type: "items_error", code: e instanceof Error && /^[a-z_]{3,30}$/.test(e.message) ? e.message : "failed" });
        }
      } else if (type === "token") {
        // A refreshed access token: it has to belong to the same person, who has to still belong to the project.
        const parsed = tokenMsg.safeParse(msg);
        const userId = parsed.success ? await deps.authenticate(parsed.data.token).catch(() => null) : null;
        if (userId !== conn.userId) fail(ws, "unauthorized", 4401);
        else authedAt = Date.now();
      }
    });
  });

  return {
    /** Hand the HTTP server's upgrade requests for /api/folder-host to the relay. */
    attach(server: Server, skip?: (path: string) => boolean) {
      server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const path = (req.url ?? "").split("?")[0];
        if (skip?.(path ?? "")) return; // another relay's path: left alone
        // The host's app is not a web page and sends no Origin; a browser always does. Keeping browsers out
        // closes off cross-site WebSocket tricks.
        if (path !== "/api/folder-host" || req.headers.origin !== undefined || open >= MAX_CONNECTIONS) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return void socket.destroy();
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      });
    },

    isOnline: (projectId: string, ownerId: string) => hosts.has(keyOf(projectId, ownerId)),

    /** The owners whose apps are connected for this project. */
    onlineOwners: (projectId: string): string[] => [...hosts.values()].filter((c) => c.projectId === projectId).map((c) => c.userId),

    /** Tells an owner's app what the project now calls its items (after an approval, a decline or a removal). */
    pushItems(projectId: string, ownerId: string, items: ShareItemOut[]) {
      const conn = hosts.get(keyOf(projectId, ownerId));
      if (conn) send(conn.ws, { type: "items", items });
    },

    /** Disconnects one owner's app, for example after they left the project. */
    disconnect(projectId: string, ownerId: string, code = 4403, reason = "not_found") {
      const conn = hosts.get(keyOf(projectId, ownerId));
      if (conn) {
        send(conn.ws, { type: "error", code: reason });
        conn.ws.close(code, reason);
      }
    },

    /** What this owner allows the AI to propose. Nothing while their app is offline. */
    capsOf: (projectId: string, ownerId: string): FolderCaps => hosts.get(keyOf(projectId, ownerId))?.caps ?? { edit: false, git: false, exec: false },

    /** Asks one owner's app. Callers must already have checked that the asker belongs to the project and that the path points into this owner's item. */
    callOwner<K extends RelayRequest["op"]>(
      projectId: string,
      ownerId: string,
      req: Extract<RelayRequest, { op: K }>,
      opts: CallOptions = {},
    ): Promise<
      K extends "list"
        ? FolderListResult
        : K extends "read"
          ? FolderReadResult
          : K extends "glob"
            ? FolderGlobResult
            : K extends "grep"
              ? FolderSearchResult
              : K extends "git"
                ? GitStatusResult | GitTextResult
                : K extends "git_change"
                  ? GitChangeResult
                  : K extends "exec"
                    ? ExecResult
                    : ChangeResult
    > {
      const conn = hosts.get(keyOf(projectId, ownerId));
      if (!conn || conn.ws.readyState !== conn.ws.OPEN) return Promise.reject(new RelayError("offline", "The desktop app of the person who shares this is offline."));
      if (conn.pending.size >= MAX_PENDING) return Promise.reject(new RelayError("busy", "The shared folder is busy. Try again in a moment."));
      const isChange = req.op === "edit" || req.op === "write" || req.op === "git_change" || req.op === "exec";
      if (isChange && [...conn.pending.values()].filter((p) => p.op === "edit" || p.op === "write" || p.op === "git_change" || p.op === "exec").length >= L.proposals) {
        return Promise.reject(new RelayError("busy", "Several changes are already waiting for the owner. Wait for them to be decided."));
      }
      if (isChange) {
        const now = Date.now();
        conn.proposed = conn.proposed.filter((t) => now - t < PROPOSAL_WINDOW_MS);
        if (conn.proposed.length >= MAX_PROPOSALS_PER_WINDOW) return Promise.reject(new RelayError("busy", "Too many changes were proposed in a short time. Wait a few minutes before proposing more."));
        conn.proposed.push(now);
      }
      if (opts.signal?.aborted) return Promise.reject(new RelayError("cancelled", "Cancelled."));
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
        };
        const timer = setTimeout(() => {
          conn.pending.delete(id);
          finish();
          if (isChange) send(conn.ws, { type: "cancel", id });
          reject(new RelayError("timeout", "The app took too long to answer."));
        }, opts.timeoutMs ?? requestMs);
        const onAbort = () => {
          if (!conn.pending.delete(id)) return;
          finish();
          send(conn.ws, { type: "cancel", id });
          reject(new RelayError("cancelled", "Cancelled."));
        };
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        conn.pending.set(id, {
          op: req.op,
          resolve: (v) => (finish(), resolve(v as never)),
          reject: (e) => (finish(), reject(e)),
          timer,
          onPreview: opts.onPreview,
        });
        send(conn.ws, { type: "req", req: { ...req, id } });
      });
    },

    close() {
      for (const conn of hosts.values()) conn.ws.close(1001, "shutdown");
      wss.close();
    },
  };
}

export type Relay = ReturnType<typeof createRelay>;
