import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { createHub, type Share } from "./folder-hub.ts";
import { RelayError, type Relay, type RelayRequest } from "./folder-relay.ts";

const P = "11111111-1111-4111-8111-111111111111";
const share = (owner: string, name: string, kind: "dir" | "file" = "dir", status: "active" | "pending" = "active"): Share => ({ id: `${owner}-${name}`, owner_id: owner, item_key: `key-${name}`, name, kind, status });

let shares: Share[] = [];
let online: string[] = [];
let caps: Record<string, { edit: boolean; git: boolean; exec: boolean }> = {};
let sent: { owner: string; req: RelayRequest }[] = [];
let answers: Record<string, (req: RelayRequest) => unknown> = {};
let loads = 0;

const relay = {
  onlineOwners: () => online,
  capsOf: (_p: string, owner: string) => caps[owner] ?? { edit: false, git: false, exec: false },
  callOwner: async (_p: string, owner: string, req: RelayRequest) => {
    sent.push({ owner, req });
    if (!online.includes(owner)) throw new RelayError("offline", "offline");
    // An app that answers as it should: with the path it was asked about.
    return answers[owner]?.(req) ?? ("path" in req && typeof req.path === "string" ? { path: req.path.replace(/^\/+/, ""), entries: [], created: false, added: 0, removed: 0, paths: [], matches: [], truncated: false } : { paths: [], matches: [], truncated: false });
  },
} as unknown as Relay;

const hub = createHub(relay, {
  loadShares: async () => {
    loads++;
    return shares;
  },
});

beforeEach(() => {
  shares = [share("ana", "my-app"), share("ben", "notes", "dir"), share("ben", "todo.md", "file"), share("cat", "secret-plans", "dir", "pending")];
  online = ["ana", "ben", "cat"];
  caps = {};
  sent = [];
  answers = {};
  loads = 0;
  hub.invalidate(P);
});

const call = (req: RelayRequest) => hub.call(P, req as never) as Promise<Record<string, unknown>>;
const refused = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof RelayError && e.kind === "host" && e.code === code);

describe("the top level", () => {
  test("lists approved items by name, folders first, without asking any app", async () => {
    const r = await call({ op: "list", path: "" });
    assert.deepEqual(r.entries, [
      { name: "my-app", type: "dir" },
      { name: "notes", type: "dir" },
      { name: "todo.md", type: "file" },
    ]);
    assert.equal(sent.length, 0);
  });
  test("works while every owner is offline, and never shows a request that waits for approval", async () => {
    online = [];
    const r = await call({ op: "list", path: "/" });
    assert.equal((r.entries as { name: string }[]).some((e) => e.name === "secret-plans"), false);
    assert.equal((r.entries as unknown[]).length, 3);
  });
  test("nothing approved at all is not_found", async () => {
    shares = [share("cat", "secret-plans", "dir", "pending")];
    await refused(call({ op: "list", path: "" }), "not_found");
  });
});

describe("routing by the first path segment", () => {
  test("a path goes to the owner of the item it starts with, unchanged", async () => {
    await call({ op: "list", path: "notes/src" });
    await call({ op: "read", path: "my-app/src/a.ts" });
    await call({ op: "edit", path: "notes/x.md", oldString: "a", newString: "b", askedBy: "u", readFiles: 1 });
    await call({ op: "write", path: "todo.md", content: "x", hadRead: false, askedBy: "u", readFiles: 0 });
    assert.deepEqual(sent.map((s) => [s.owner, (s.req as { path: string }).path]), [
      ["ben", "notes/src"],
      ["ana", "my-app/src/a.ts"],
      ["ben", "notes/x.md"],
      ["ben", "todo.md"],
    ]);
  });
  test("an item nobody approved, an unknown name, and a path that only looks like an item are refused before any app is asked", async () => {
    for (const path of ["secret-plans/a.txt", "nope/a.txt", "MY-APP/a.ts", "my-app2/a.ts", "../my-app/a.ts", "./my-app/a", ""]) {
      await refused(call({ op: "read", path }), path === "" ? "bad_request" : "not_found");
    }
    assert.equal(sent.length, 0);
  });
  test("an offline owner makes only their own items unavailable", async () => {
    online = ["ana", "cat"];
    await assert.rejects(call({ op: "read", path: "notes/a.md" }), (e: unknown) => e instanceof RelayError && e.kind === "offline");
    await call({ op: "read", path: "my-app/a.ts" });
    assert.equal(sent.at(-1)!.owner, "ana");
  });
  test("a leading slash still names the item", async () => {
    await call({ op: "read", path: "/my-app/a.ts" });
    assert.equal(sent.at(-1)!.owner, "ana");
  });
});

describe("an app can only answer about the item it was asked about", () => {
  test("a read or list that names a path outside the item is refused", async () => {
    answers.ben = () => ({ path: "my-app/a.ts", text: "forged", startLine: 1, endLine: 1, totalLines: 1, truncated: false });
    await assert.rejects(call({ op: "read", path: "notes/a.md" }), (e: unknown) => e instanceof RelayError && e.kind === "bad_answer");
    answers.ben = () => ({ path: "notes/a.md", text: "ok", startLine: 1, endLine: 1, totalLines: 1, truncated: false });
    assert.equal((await call({ op: "read", path: "notes/a.md" })).path, "notes/a.md");
    answers.ben = () => ({ path: "", entries: [], truncated: false });
    await assert.rejects(call({ op: "list", path: "notes" }), (e: unknown) => e instanceof RelayError && e.kind === "bad_answer");
  });
  test("a search with a path keeps only results inside that item", async () => {
    answers.ben = () => ({ matches: [{ path: "notes/a.md", line: 1, text: "x" }, { path: "my-app/a.ts", line: 1, text: "forged" }, { path: "todo.md", line: 1, text: "other item" }], truncated: false });
    const r = await call({ op: "grep", pattern: "x", path: "notes" });
    assert.deepEqual((r.matches as { path: string }[]).map((m) => m.path), ["notes/a.md"]);
    answers.ben = () => ({ paths: ["notes/a.md", "my-app/a.ts"], truncated: false });
    assert.deepEqual((await call({ op: "glob", pattern: "*", path: "notes" })).paths, ["notes/a.md"]);
  });
  test("a change result or preview for a file in another item is not trusted", async () => {
    answers.ben = () => ({ path: "my-app/a.ts", created: false, added: 1, removed: 1 });
    await assert.rejects(call({ op: "edit", path: "notes/a.md", oldString: "a", newString: "b", askedBy: "u", readFiles: 1 }), (e: unknown) => e instanceof RelayError && e.kind === "bad_answer");
    const seen: string[] = [];
    const original = relay.callOwner;
    relay.callOwner = (async (_p: string, _o: string, _req: unknown, o: { onPreview?: (c: unknown) => void }) => {
      o.onPreview?.({ kind: "edit", path: "my-app/forged.ts" });
      o.onPreview?.({ kind: "edit", path: "notes/real.md" });
      return { path: "notes/real.md", created: false, added: 0, removed: 0 };
    }) as never;
    try {
      await hub.call(P, { op: "edit", path: "notes/real.md", oldString: "a", newString: "b", askedBy: "u", readFiles: 1 } as never, { onPreview: (c: { path: string }) => void seen.push(c.path) } as never);
    } finally {
      relay.callOwner = original;
    }
    assert.deepEqual(seen, ["notes/real.md"]);
  });
});

describe("search across items", () => {
  test("a search with no path asks every online owner and merges, in the item's own names", async () => {
    answers.ana = () => ({ matches: [{ path: "my-app/a.ts", line: 1, text: "x" }], truncated: false });
    answers.ben = () => ({ matches: [{ path: "notes/b.md", line: 2, text: "y" }], truncated: false });
    answers.cat = () => ({ matches: [{ path: "secret-plans/c.md", line: 3, text: "z" }], truncated: false });
    const r = await call({ op: "grep", pattern: "x" });
    assert.deepEqual((r.matches as { path: string }[]).map((m) => m.path).sort(), ["my-app/a.ts", "notes/b.md"]);
  });
  test("what an app returns outside its own approved items is dropped, even if it claims it", async () => {
    answers.ana = () => ({ paths: ["my-app/a.ts", "notes/b.md", "secret-plans/c.md", "elsewhere/d.md", "../../etc/passwd"], truncated: false });
    answers.ben = () => ({ paths: ["notes/b.md", "todo.md"], truncated: false });
    answers.cat = () => ({ paths: ["secret-plans/c.md"], truncated: false });
    const r = await call({ op: "glob", pattern: "*" });
    assert.deepEqual((r.paths as string[]).sort(), ["my-app/a.ts", "notes/b.md", "todo.md"]);
  });
  test("one owner offline or failing does not break the search; all of them offline does", async () => {
    online = ["ana"];
    answers.ana = () => ({ paths: ["my-app/a.ts"], truncated: false });
    assert.deepEqual((await call({ op: "glob", pattern: "*" })).paths, ["my-app/a.ts"]);
    online = [];
    await assert.rejects(call({ op: "glob", pattern: "*" }), (e: unknown) => e instanceof RelayError && e.kind === "offline");
    online = ["ana", "ben"];
    answers.ben = () => {
      throw new RelayError("host", "boom", "failed");
    };
    assert.deepEqual((await call({ op: "glob", pattern: "*" })).paths, ["my-app/a.ts"]);
  });
  test("the merged result respects the limit and says when it was cut", async () => {
    answers.ana = () => ({ paths: Array.from({ length: 80 }, (_, i) => `my-app/${i}.ts`), truncated: false });
    answers.ben = () => ({ paths: Array.from({ length: 80 }, (_, i) => `notes/${i}.md`), truncated: false });
    const r = await call({ op: "glob", pattern: "*", limit: 100 });
    assert.equal((r.paths as string[]).length, 100);
    assert.equal(r.truncated, true);
  });
  test("a search with a path goes only to that item's owner", async () => {
    await call({ op: "grep", pattern: "x", path: "notes/src" });
    assert.deepEqual(sent.map((s) => s.owner), ["ben"]);
  });
});

describe("git and commands", () => {
  test("with exactly one approved folder, a request with no path goes to it", async () => {
    shares = [share("ana", "my-app"), share("ben", "todo.md", "file"), share("cat", "x", "dir", "pending")];
    hub.invalidate(P);
    await call({ op: "git", sub: "status" });
    await call({ op: "exec", command: "ls" } as never);
    await call({ op: "git_change", action: "commit", message: "m", askedBy: "u", readFiles: 1 });
    assert.deepEqual(sent.map((s) => s.owner), ["ana", "ana", "ana"]);
  });
  test("with several folders a path-less request is refused rather than guessed", async () => {
    await refused(call({ op: "git", sub: "status" }), "bad_request");
    await refused(call({ op: "exec", command: "ls" } as never), "bad_request");
    await refused(call({ op: "git_change", action: "branch", name: "b", askedBy: "u", readFiles: 1 }), "bad_request");
    assert.equal(sent.length, 0);
  });
  test("a path or workdir names the folder", async () => {
    await call({ op: "git", sub: "diff", path: "notes" });
    await call({ op: "exec", command: "ls", workdir: "my-app/src" } as never);
    await call({ op: "git_change", action: "add", paths: ["notes/a.md", "notes/b.md"], askedBy: "u", readFiles: 1 });
    assert.deepEqual(sent.map((s) => s.owner), ["ben", "ana", "ben"]);
  });
  test("one git action cannot span folders of different owners", async () => {
    await refused(call({ op: "git_change", action: "add", paths: ["notes/a.md", "my-app/b.ts"], askedBy: "u", readFiles: 1 }), "bad_request");
    await refused(call({ op: "git_change", action: "restore", paths: ["notes/a.md", "secret-plans/b.ts"], askedBy: "u", readFiles: 1 }), "bad_request");
    assert.equal(sent.length, 0);
  });
});

describe("caps and the cache", () => {
  test("caps are what any connected owner of an approved item allows", async () => {
    assert.deepEqual(await hub.caps(P), { edit: false, git: false, exec: false });
    caps.ben = { edit: true, git: false, exec: false };
    caps.cat = { edit: true, git: true, exec: true }; // only a request: does not count
    assert.deepEqual(await hub.caps(P), { edit: true, git: false, exec: false });
    online = ["ana"];
    assert.deepEqual(await hub.caps(P), { edit: false, git: false, exec: false });
  });
  test("editState tells why the AI cannot edit: off, offline, or allowed", async () => {
    assert.equal(await hub.editState(P), "off"); // apps connected, switch off
    caps.ben = { edit: true, git: false, exec: false };
    assert.equal(await hub.editState(P), "edit");
    online = [];
    assert.equal(await hub.editState(P), "offline");
    online = ["cat"]; // cat only has a pending request: not an owner of an approved item
    assert.equal(await hub.editState(P), "offline");
  });
  test("the list is cached for a moment and read again after invalidate()", async () => {
    await call({ op: "read", path: "my-app/a" });
    await call({ op: "read", path: "my-app/b" });
    assert.equal(loads, 1);
    shares = [share("ana", "renamed")];
    await call({ op: "read", path: "my-app/c" }); // still the cached list
    hub.invalidate(P);
    await refused(call({ op: "read", path: "my-app/c" }), "not_found");
    assert.equal(loads, 2);
  });
  test("a failed load is not cached", async () => {
    const failing = createHub(relay, {
      loadShares: async () => {
        loads++;
        if (loads === 1) throw new Error("db down");
        return shares;
      },
    });
    await assert.rejects(failing.call(P, { op: "read", path: "my-app/a" } as never));
    await failing.call(P, { op: "read", path: "my-app/a" } as never);
    assert.equal(loads, 2);
  });
  test("itemsOf reports one owner's items with their status, including requests", async () => {
    assert.deepEqual(await hub.itemsOf(P, "cat"), [{ key: "key-secret-plans", name: "secret-plans", status: "pending" }]);
  });
});


describe("older design files", () => {
  test("are read (only read) from the owner of the item", async () => {
    const r = await call({ op: "design_read", path: "my-app/designs/a.design.html" });
    assert.equal(r.path, "my-app/designs/a.design.html");
    assert.equal(sent[0]!.owner, "ana");
    assert.equal(sent[0]!.req.op, "design_read");
  });
  test("only paths ending in .design.html, and only in approved items", async () => {
    await refused(call({ op: "design_read", path: "my-app/a.html" }), "bad_request");
    await refused(call({ op: "design_read", path: "secret-plans/a.design.html" }), "not_found");
    assert.equal(sent.length, 0);
  });
});
