import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import WebSocket from "ws";
import { createRelay, RelayError, type RelayDeps } from "./folder-relay.ts";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

const online: Record<string, boolean> = {};
const synced: { user: string; project: string; items: unknown }[] = [];
const deps: RelayDeps = {
  authenticate: async (t) => (t === "host-token" ? "host" : t === "other-token" ? "other" : t === "outsider-token" ? "outsider" : null),
  // "host" and "other" belong to P1 and P2, "outsider" to nothing, and nobody belongs to anything else.
  connectCheck: async (user, project) => (user !== "outsider" && (project === P1 || project === P2) ? { ok: true } : { ok: false, reason: "not_found" }),
  sync: async (user, project, items) => {
    synced.push({ user, project, items });
    if (user === "other" && items.length > 1) throw new Error("too_many");
    return items.map((i) => ({ key: i.key, name: i.name, status: user === "host" ? ("active" as const) : ("pending" as const) }));
  },
  setOnline: async (project, owner, on) => {
    online[`${project}:${owner}`] = on;
  },
};

let server: Server;
let relay: ReturnType<typeof createRelay>;
let port = 0;

before(async () => {
  relay = createRelay(deps, { requestMs: 400 });
  server = createServer((_req, res) => res.end("ok"));
  relay.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  relay.close();
  server.close();
});

/** Connects like the desktop app does and says hello. Resolves with the socket and the first message the server sends. */
async function connect(token: string, project: string, opts?: WebSocket.ClientOptions, items: { key: string; name: string; kind: string }[] = []) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/folder-host`, opts);
  const messages: Record<string, unknown>[] = [];
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  ws.send(JSON.stringify({ type: "hello", token, projectId: project, items }));
  const first = async () => {
    for (let i = 0; i < 300 && messages.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    return messages[0];
  };
  return { ws, messages, closed, first };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), "timed out");
};

/** Answers every request with `reply(req)`. */
function answerWith(ws: WebSocket, reply: (req: Record<string, unknown>) => Record<string, unknown>) {
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as { type: string; req?: Record<string, unknown> };
    if (msg.type === "req" && msg.req) ws.send(JSON.stringify({ type: "res", res: { id: msg.req.id, ...reply(msg.req) } }));
  });
}

describe("connecting", () => {
  test("a bad token is refused", async () => {
    const c = await connect("nope", P1);
    assert.deepEqual(await c.first(), { type: "error", code: "unauthorized" });
    assert.equal(await c.closed, 4401);
    assert.equal(relay.isOnline(P1, "host"), false);
  });
  test("someone outside the project is refused", async () => {
    const c = await connect("outsider-token", P1);
    assert.deepEqual(await c.first(), { type: "error", code: "not_found" });
    assert.equal(await c.closed, 4403);
  });
  test("an unknown project is refused", async () => {
    const c = await connect("host-token", "33333333-3333-4333-8333-333333333333");
    assert.deepEqual(await c.first(), { type: "error", code: "not_found" });
  });
  test("a hello without items, or with too many or odd ones, closes the socket", async () => {
    for (const items of [undefined, Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, name: `n${i}`, kind: "dir" })), [{ key: "", name: "a", kind: "dir" }], [{ key: "k", name: "a", kind: "socket" }]]) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/folder-host`);
      const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
      await new Promise((resolve, reject) => (ws.on("open", resolve), ws.on("error", reject)));
      ws.send(JSON.stringify({ type: "hello", token: "host-token", projectId: P1, ...(items ? { items } : {}) }));
      assert.equal(await closed, 1008);
    }
  });
  test("the database's refusal of the items is sent to the app with its code", async () => {
    const c = await connect("other-token", P1, undefined, [{ key: "a", name: "a", kind: "dir" }, { key: "b", name: "b", kind: "dir" }]);
    assert.deepEqual(await c.first(), { type: "error", code: "too_many" });
    assert.equal(await c.closed, 4400);
    assert.equal(relay.isOnline(P1, "other"), false);
  });
  test("junk before hello closes the socket", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/folder-host`);
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "req", req: { id: "x", op: "list", path: "" } }));
    assert.equal(await closed, 1008);
  });
  test("browsers (anything with an Origin) and other paths are refused", async () => {
    await assert.rejects(new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/folder-host`, { origin: "https://evil.example" });
      ws.on("open", resolve);
      ws.on("error", reject);
    }), /403/);
    await assert.rejects(new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
      ws.on("open", resolve);
      ws.on("error", reject);
    }), /403/);
  });
});

describe("serving", () => {
  test("the host connects, goes online, answers, and goes offline on disconnect", async () => {
    const c = await connect("host-token", P1);
    assert.deepEqual(await c.first(), { type: "ready", items: [] });
    assert.equal(relay.isOnline(P1, "host"), true);
    assert.equal(online[`${P1}:host`], true);

    answerWith(c.ws, (req) => ({ ok: true, result: { path: req.path, entries: [{ name: "a.ts", type: "file", size: 3 }], truncated: false } }));
    const r = await relay.callOwner(P1, "host", { op: "list", path: "src" });
    assert.deepEqual(r.entries, [{ name: "a.ts", type: "file", size: 3 }]);

    c.ws.close();
    await c.closed;
    await until(() => !relay.isOnline(P1, "host"));
    await until(() => online[`${P1}:host`] === false);
    await assert.rejects(relay.callOwner(P1, "host", { op: "list", path: "" }), (e: unknown) => e instanceof RelayError && e.kind === "offline");
  });

  test("a host error comes back with its code and message", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    answerWith(c.ws, () => ({ ok: false, code: "excluded", message: "Hidden." }));
    await assert.rejects(relay.callOwner(P1, "host", { op: "read", path: ".env" }), (e: unknown) => e instanceof RelayError && e.kind === "host" && e.code === "excluded" && e.message === "Hidden.");
    c.ws.close();
    await until(() => !relay.isOnline(P1, "host"));
  });

  test("answers that break the rules are rejected, not passed on", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    const bad = [
      { ok: true, result: { path: "", entries: [{ name: "evil\nname", type: "file" }], truncated: false } },
      { ok: true, result: { path: "", entries: Array.from({ length: 501 }, (_, i) => ({ name: `f${i}`, type: "file" })), truncated: false } },
      { ok: true, result: "not an object" },
      { ok: true, result: { path: "", entries: [{ name: "a", type: "symlink" }], truncated: false } },
    ];
    let i = 0;
    answerWith(c.ws, () => bad[i++ % bad.length]!);
    for (let n = 0; n < bad.length; n++) {
      await assert.rejects(relay.callOwner(P1, "host", { op: "list", path: "" }), (e: unknown) => e instanceof RelayError && e.kind === "bad_answer");
    }
    c.ws.close();
    await until(() => !relay.isOnline(P1, "host"));
  });

  test("a read result must fit the limits", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    answerWith(c.ws, () => ({ ok: true, result: { path: "a", text: "x".repeat(200_000), startLine: 1, endLine: 1, totalLines: 1, truncated: false } }));
    await assert.rejects(relay.callOwner(P1, "host", { op: "read", path: "a" }), (e: unknown) => e instanceof RelayError && e.kind === "bad_answer");
    c.ws.close();
    await until(() => !relay.isOnline(P1, "host"));
  });

  test("an answer that never comes times out; unknown ids are ignored", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    c.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string };
      if (msg.type === "req") c.ws.send(JSON.stringify({ type: "res", res: { id: "not-a-pending-id", ok: true, result: {} } }));
    });
    await assert.rejects(relay.callOwner(P1, "host", { op: "list", path: "" }), (e: unknown) => e instanceof RelayError && e.kind === "timeout");
    c.ws.close();
    await until(() => !relay.isOnline(P1, "host"));
  });

  test("too many requests at once are turned away", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    const calls = Array.from({ length: 16 }, () => relay.callOwner(P1, "host", { op: "list", path: "" }).catch((e: unknown) => e));
    await assert.rejects(relay.callOwner(P1, "host", { op: "list", path: "" }), (e: unknown) => e instanceof RelayError && e.kind === "busy");
    await Promise.all(calls); // they time out
    c.ws.close();
    await until(() => !relay.isOnline(P1, "host"));
  });

  test("a new connection replaces the old one and the folder stays online", async () => {
    const a = await connect("host-token", P2);
    await a.first();
    const b = await connect("host-token", P2);
    await b.first();
    assert.equal(await a.closed, 4000);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(relay.isOnline(P2, "host"), true);
    assert.equal(online[`${P2}:host`], true);
    answerWith(b.ws, () => ({ ok: true, result: { matches: [], truncated: false } }));
    assert.deepEqual((await relay.callOwner(P2, "host", { op: "grep", pattern: "x" })).matches, []);
    b.ws.close();
    await until(() => !relay.isOnline(P2, "host"));
  });

  test("a refreshed token for someone else ends the connection; one for the same person does not", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    c.ws.send(JSON.stringify({ type: "token", token: "host-token" }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(relay.isOnline(P1, "host"), true);
    c.ws.send(JSON.stringify({ type: "token", token: "other-token" }));
    assert.equal(await c.closed, 4401);
  });

  test("disconnect() ends one owner's connection", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    relay.disconnect(P1, "host");
    assert.equal(await c.closed, 4403);
    await until(() => !relay.isOnline(P1, "host"));
  });

  test("an oversized frame closes the socket", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    c.ws.send("x".repeat(2 * 1024 * 1024));
    assert.ok([1006, 1009].includes(await c.closed)); // too big: the server drops the connection
    await until(() => !relay.isOnline(P1, "host"));
  });
});

describe("sign-in age", () => {
  test("a connection whose token is never refreshed is closed", async () => {
    const short = createRelay(deps, { tokenMaxMs: 150, pingMs: 50 });
    const srv = createServer();
    short.attach(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const ws = new WebSocket(`ws://127.0.0.1:${(srv.address() as AddressInfo).port}/api/folder-host`);
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", token: "host-token", projectId: P1, items: [] }));
    assert.equal(await closed, 4401);
    short.close();
    srv.close();
  });
});

describe("AI changes", () => {
  const preview = (id: string) => ({ id, kind: "edit", path: "src/a.ts", created: false, added: 1, removed: 1, diff: "@@ -1,1 +1,1 @@\n-a\n+b", cut: false });
  const edit = { op: "edit", path: "src/a.ts", oldString: "a", newString: "b", askedBy: "Ana", readFiles: 1 } as const;

  test("caps are nothing until the host's app says so, then follow it", async () => {
    const c = await connect("host-token", P2);
    await c.first();
    assert.deepEqual(relay.capsOf(P2, "host"), { edit: false, git: false, exec: false });
    c.ws.send(JSON.stringify({ type: "caps", caps: { edit: true, git: true, exec: true } }));
    await until(() => relay.capsOf(P2, "host").edit && relay.capsOf(P2, "host").git && relay.capsOf(P2, "host").exec);
    c.ws.send(JSON.stringify({ type: "caps", caps: { edit: "yes", git: true, exec: true } })); // junk is ignored
    c.ws.send(JSON.stringify({ type: "caps", caps: { edit: true, git: true } })); // an old app that does not know commands is ignored too
    c.ws.send(JSON.stringify({ type: "caps", caps: { edit: false, git: false, exec: false } }));
    await until(() => !relay.capsOf(P2, "host").edit && !relay.capsOf(P2, "host").git && !relay.capsOf(P2, "host").exec);
    c.ws.close();
    await c.closed;
    assert.deepEqual(relay.capsOf(P2, "host"), { edit: false, git: false, exec: false });
  });

  test("the preview arrives once, then the host's decision, with a long wait allowed", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    c.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; req?: { id: string } };
      if (msg.type !== "req") return;
      const id = msg.req!.id;
      c.ws.send(JSON.stringify({ type: "event", id, event: "pending", change: preview(id) }));
      c.ws.send(JSON.stringify({ type: "event", id, event: "pending", change: preview(id) })); // a repeat is ignored
      setTimeout(() => c.ws.send(JSON.stringify({ type: "res", res: { id, ok: true, result: { path: "src/a.ts", created: false, added: 1, removed: 1 } } })), 600); // longer than requestMs (400)
    });
    const seen: string[] = [];
    const res = await relay.callOwner(P1, "host", edit, { timeoutMs: 3000, onPreview: (ch) => seen.push(ch.diff) });
    assert.deepEqual(res, { path: "src/a.ts", created: false, added: 1, removed: 1 });
    assert.equal(seen.length, 1);
    c.ws.close();
    await c.closed;
  });

  test("a preview for another request, or a malformed one, is not passed on", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    c.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; req?: { id: string } };
      if (msg.type !== "req") return;
      const id = msg.req!.id;
      c.ws.send(JSON.stringify({ type: "event", id, event: "pending", change: preview("someone-else") }));
      c.ws.send(JSON.stringify({ type: "event", id, event: "pending", change: { ...preview(id), diff: "x".repeat(60_000) } }));
      c.ws.send(JSON.stringify({ type: "event", id: "unknown", event: "pending", change: preview("unknown") }));
      c.ws.send(JSON.stringify({ type: "res", res: { id, ok: false, code: "denied", message: "The host declined this change." } }));
    });
    let previews = 0;
    await assert.rejects(relay.callOwner(P1, "host", edit, { onPreview: () => previews++ }), (e: unknown) => e instanceof RelayError && e.kind === "host" && e.code === "denied");
    assert.equal(previews, 0);
    c.ws.close();
    await c.closed;
  });

  test("aborting withdraws the request from the host's app", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    const frames: Record<string, unknown>[] = [];
    c.ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
    const ctl = new AbortController();
    const p = relay.callOwner(P1, "host", edit, { timeoutMs: 5000, signal: ctl.signal });
    await until(() => frames.some((f) => f.type === "req"));
    ctl.abort();
    await assert.rejects(p, (e: unknown) => e instanceof RelayError && e.kind === "cancelled");
    const req = frames.find((f) => f.type === "req") as { req: { id: string } };
    await until(() => frames.some((f) => f.type === "cancel" && f.id === req.req.id));
    await assert.rejects(relay.callOwner(P1, "host", edit, { signal: ctl.signal }), (e: unknown) => e instanceof RelayError && e.kind === "cancelled");
    c.ws.close();
    await c.closed;
  });

  test("only a few changes wait at once, and a timeout cancels on the host's side", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    const frames: Record<string, unknown>[] = [];
    c.ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
    const open = [1, 2, 3].map(() => relay.callOwner(P1, "host", edit, { timeoutMs: 300 }));
    await assert.rejects(relay.callOwner(P1, "host", edit, { timeoutMs: 300 }), (e: unknown) => e instanceof RelayError && e.kind === "busy");
    for (const p of open) await assert.rejects(p, (e: unknown) => e instanceof RelayError && e.kind === "timeout");
    await until(() => frames.filter((f) => f.type === "cancel").length === 3);
    c.ws.close();
    await c.closed;
  });

  test("the answer to a change is checked", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    answerWith(c.ws, () => ({ ok: true, result: { path: "src/a.ts", created: "maybe" } }));
    await assert.rejects(relay.callOwner(P1, "host", edit), (e: unknown) => e instanceof RelayError && e.kind === "bad_answer");
    c.ws.close();
    await c.closed;
  });

  test("a flood of proposals is limited", async () => {
    const c = await connect("host-token", P2);
    await c.first();
    answerWith(c.ws, () => ({ ok: true, result: { path: "a.ts", created: false, added: 1, removed: 1 } }));
    for (let i = 0; i < 30; i++) await relay.callOwner(P2, "host", edit);
    await assert.rejects(relay.callOwner(P2, "host", edit), (e: unknown) => e instanceof RelayError && e.kind === "busy" && /Too many/.test(e.message));
    await relay.callOwner(P2, "host", { op: "list", path: "" }).catch(() => undefined); // reads are not limited
    c.ws.close();
    await c.closed;
  });

  test("git reads come back checked, as a status or as text", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    c.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; req?: { id: string; sub: string } };
      if (msg.type !== "req") return;
      const result = msg.req!.sub === "status" ? { branch: "main", files: [{ path: "src/a.ts", index: " ", worktree: "M" }], truncated: false } : msg.req!.sub === "diff" ? { text: "@@ -1 +1 @@", truncated: false } : { files: "junk" };
      c.ws.send(JSON.stringify({ type: "res", res: { id: msg.req!.id, ok: true, result } }));
    });
    assert.deepEqual(await relay.callOwner(P1, "host", { op: "git", sub: "status" }), { branch: "main", files: [{ path: "src/a.ts", index: " ", worktree: "M" }], truncated: false });
    assert.deepEqual(await relay.callOwner(P1, "host", { op: "git", sub: "diff" }), { text: "@@ -1 +1 @@", truncated: false });
    await assert.rejects(relay.callOwner(P1, "host", { op: "git", sub: "log" }), (e: unknown) => e instanceof RelayError && e.kind === "bad_answer");
    c.ws.close();
    await c.closed;
  });

  test("a git action is a proposal: preview with its command, then the host's decision", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    c.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; req?: { id: string } };
      if (msg.type !== "req") return;
      const id = msg.req!.id;
      c.ws.send(JSON.stringify({ type: "event", id, event: "pending", change: { id, kind: "git", path: "git commit", command: 'git commit -m "x"', destructive: false, created: false, added: 1, removed: 0, diff: "@@ commit message @@", cut: false } }));
      c.ws.send(JSON.stringify({ type: "res", res: { id, ok: true, result: { command: 'git commit -m "x"', output: "[main abc] x" } } }));
    });
    const seen: string[] = [];
    const res = await relay.callOwner(P1, "host", { op: "git_change", action: "commit", message: "x", askedBy: "Ana", readFiles: 1 }, { onPreview: (ch) => seen.push(`${ch.kind} ${ch.command}`) });
    assert.deepEqual(res, { command: 'git commit -m "x"', output: "[main abc] x" });
    assert.deepEqual(seen, ['git git commit -m "x"']);
    c.ws.close();
    await c.closed;
  });

  test("a command is a proposal: preview with its folder and limit, then the host's decision and its output", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    c.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; req?: { id: string; command: string } };
      if (msg.type !== "req") return;
      const id = msg.req!.id;
      c.ws.send(JSON.stringify({ type: "event", id, event: "pending", change: { id, kind: "exec", path: "run a command", command: msg.req!.command, workdir: "src", timeoutSec: 30, note: "run the tests", created: false, added: 0, removed: 0, diff: "", cut: false } }));
      c.ws.send(JSON.stringify({ type: "res", res: { id, ok: true, result: { command: msg.req!.command, exitCode: 0, signal: null, timedOut: false, output: "ok\n", truncated: false, ms: 12 } } }));
    });
    const seen: string[] = [];
    const res = await relay.callOwner(P1, "host", { op: "exec", command: "npm test", description: "run the tests", workdir: "src", timeoutSec: 30, askedBy: "Ana", readFiles: 1 }, { onPreview: (ch) => seen.push(`${ch.kind} ${ch.command} ${ch.workdir} ${ch.timeoutSec}`) });
    assert.equal((res as { output: string }).output, "ok\n");
    assert.deepEqual(seen, ["exec npm test src 30"]);
    c.ws.close();
    await c.closed;
  });

  test("a command's answer is checked", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    answerWith(c.ws, () => ({ ok: true, result: { command: "x", exitCode: "zero" } }));
    await assert.rejects(relay.callOwner(P1, "host", { op: "exec", command: "x", askedBy: "A", readFiles: 0 }), (e: unknown) => e instanceof RelayError && e.kind === "bad_answer");
    c.ws.close();
    await c.closed;
  });
});

describe("several owners", () => {
  test("each owner has their own connection; one going away does not touch the other", async () => {
    const a = await connect("host-token", P1, undefined, [{ key: "a1", name: "my-app", kind: "dir" }]);
    assert.deepEqual(await a.first(), { type: "ready", items: [{ key: "a1", name: "my-app", status: "active" }] });
    const b = await connect("other-token", P1, undefined, [{ key: "b1", name: "notes", kind: "dir" }]);
    assert.deepEqual(await b.first(), { type: "ready", items: [{ key: "b1", name: "notes", status: "pending" }] });
    assert.deepEqual(relay.onlineOwners(P1).sort(), ["host", "other"]);
    answerWith(a.ws, () => ({ ok: true, result: { matches: [{ path: "my-app/x.ts", line: 1, text: "a" }], truncated: false } }));
    answerWith(b.ws, () => ({ ok: true, result: { matches: [{ path: "notes/y.md", line: 2, text: "b" }], truncated: false } }));
    assert.equal((await relay.callOwner(P1, "host", { op: "grep", pattern: "x" })).matches[0]!.path, "my-app/x.ts");
    assert.equal((await relay.callOwner(P1, "other", { op: "grep", pattern: "x" })).matches[0]!.path, "notes/y.md");
    b.ws.close();
    await until(() => !relay.isOnline(P1, "other"));
    assert.equal(relay.isOnline(P1, "host"), true);
    await assert.rejects(relay.callOwner(P1, "other", { op: "list", path: "" }), (e: unknown) => e instanceof RelayError && e.kind === "offline");
    a.ws.close();
    await until(() => !relay.isOnline(P1, "host"));
  });

  test("an app that picks or removes something reports it and hears what the project calls it", async () => {
    const c = await connect("host-token", P1);
    await c.first();
    c.ws.send(JSON.stringify({ type: "items", items: [{ key: "z", name: "zeta", kind: "file" }] }));
    await until(() => c.messages.some((m) => m.type === "items"));
    assert.deepEqual(c.messages.find((m) => m.type === "items"), { type: "items", items: [{ key: "z", name: "zeta", status: "active" }] });
    // too many, for someone whose items are refused: an error, and the connection stays
    const d = await connect("other-token", P1);
    await d.first();
    d.ws.send(JSON.stringify({ type: "items", items: [{ key: "a", name: "a", kind: "dir" }, { key: "b", name: "b", kind: "dir" }] }));
    await until(() => d.messages.some((m) => m.type === "items_error"));
    assert.deepEqual(d.messages.find((m) => m.type === "items_error"), { type: "items_error", code: "too_many" });
    assert.equal(relay.isOnline(P1, "other"), true);
    // junk is ignored
    c.ws.send(JSON.stringify({ type: "items", items: "nope" }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(relay.isOnline(P1, "host"), true);
    c.ws.close();
    d.ws.close();
    await until(() => !relay.isOnline(P1, "host") && !relay.isOnline(P1, "other"));
  });

  test("pushItems tells one owner's app and nobody else's", async () => {
    const a = await connect("host-token", P1);
    await a.first();
    const b = await connect("other-token", P1);
    await b.first();
    relay.pushItems(P1, "other", [{ key: "b1", name: "notes", status: "active" }]);
    await until(() => b.messages.some((m) => m.type === "items"));
    assert.equal(a.messages.some((m) => m.type === "items"), false);
    a.ws.close();
    b.ws.close();
    await until(() => !relay.isOnline(P1, "host") && !relay.isOnline(P1, "other"));
  });
});
