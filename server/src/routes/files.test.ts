import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import type { ObjectStore, StoredObject } from "../r2.ts";

// The routes import modules that read the environment when they load.
process.env.SUPABASE_URL ??= "http://localhost:54399";
process.env.SUPABASE_SECRET_KEY ??= "test";
process.env.KEY_ENCRYPTION_SECRET ??= Buffer.alloc(32, 7).toString("base64");
process.env.APP_URL ??= "http://localhost:5173";

const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DIR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FILE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PENDING = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LIMITS = { projectBytes: 1024 * 1024 * 1024 };

type Share = import("../folder-hub.ts").Share;
const shares: Record<string, Share> = {
  [DIR]: { id: DIR, owner_id: OWNER, item_key: "k1", name: "app", kind: "dir", status: "active" },
  [FILE]: { id: FILE, owner_id: OWNER, item_key: "k2", name: "notes.md", kind: "file", status: "active" },
  [PENDING]: { id: PENDING, owner_id: OWNER, item_key: "k3", name: "later", kind: "dir", status: "pending" },
};
const members = new Set([OWNER, MEMBER]);

let objects: Map<string, { body: Uint8Array; modified: string }>;
let puts: { key: string; meta?: Record<string, string> }[];
let usageOverride: { bytes: number; files: number } | null | undefined;
let app: import("hono").Hono;
let offline = false;

const fakeStore = (): ObjectStore => ({
  async put(key, body, meta) {
    objects.set(key, { body, modified: "2026-10-23T12:00:00.000Z" });
    puts.push({ key, meta });
  },
  async head(key) {
    const o = objects.get(key);
    return o ? { key, bytes: o.body.length, modified: o.modified } : null;
  },
  async get(key) {
    return objects.get(key)?.body ?? null;
  },
  async list(prefix) {
    const files: StoredObject[] = [];
    const dirs = new Set<string>();
    for (const [k, o] of objects) {
      if (!k.startsWith(prefix)) continue;
      const slash = k.indexOf("/", prefix.length);
      if (slash >= 0) dirs.add(k.slice(0, slash + 1));
      else files.push({ key: k, bytes: o.body.length, modified: o.modified });
    }
    return { files, dirs: [...dirs], truncated: false };
  },
  async usage(prefix) {
    if (usageOverride !== undefined) return usageOverride;
    let bytes = 0;
    let files = 0;
    for (const [k, o] of objects) if (k.startsWith(prefix)) (bytes += o.body.length), (files += 1);
    return { bytes, files };
  },
  async remove(key) {
    objects.delete(key);
  },
  async removePrefix(prefix) {
    let n = 0;
    for (const k of [...objects.keys()]) if (k.startsWith(prefix)) (objects.delete(k), (n += 1));
    return n;
  },
  async downloadUrl(key, filename, seconds) {
    return `https://r2.example/${key}?name=${encodeURIComponent(filename)}&expires=${seconds}`;
  },
});

beforeEach(async () => {
  objects = new Map();
  puts = [];
  usageOverride = undefined;
  offline = false;
  const { Hono } = await import("hono");
  const { StorageOffError } = await import("../r2.ts");
  const { createFilesRoutes } = await import("./files.ts");
  const routes = createFilesRoutes({
    noRateLimits: true,
    store: () => {
      if (offline) throw new StorageOffError(["R2_BUCKET"]);
      return storeInstance;
    },
    access: async (user, project, share) => {
      const s = shares[share];
      return project === PROJECT && members.has(user) && s?.status === "active" ? { ok: true, share: s } : { ok: false };
    },
  });
  const storeInstance = fakeStore();
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId" as never, (c.req.header("x-user") ?? "") as never);
    await next();
  });
  app.route("/api/projects", routes);
});

const url = (share: string, op: string, path?: string, project = PROJECT) => `/api/projects/${project}/files/${share}/${op}${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`;
const send = (user: string, method: string, to: string, body?: string | Uint8Array) =>
  app.request(to, { method, headers: { "x-user": user, ...(body !== undefined ? { "content-length": String(typeof body === "string" ? Buffer.byteLength(body) : body.length) } : {}) }, body: body as BodyInit | undefined });
const key = (share: string, path: string) => `projects/${PROJECT}/${share}/${path}`;

describe("storing files", () => {
  test("the owner stores a file under project, item and path", async () => {
    const r = await send(OWNER, "PUT", url(DIR, "object", "src/a.ts"), "hello");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { path: "src/a.ts", bytes: 5 });
    assert.equal(new TextDecoder().decode(objects.get(key(DIR, "src/a.ts"))!.body), "hello");
    assert.deepEqual(puts[0]!.meta, { uploader: OWNER });
  });

  test("an item that is one file stores only that file", async () => {
    assert.equal((await send(OWNER, "PUT", url(FILE, "object", "notes.md"), "x")).status, 200);
    assert.equal((await send(OWNER, "PUT", url(FILE, "object", "other.md"), "x")).status, 400);
    assert.equal((await send(OWNER, "PUT", url(FILE, "object", "notes.md/x"), "x")).status, 400);
  });

  test("a member who is not the owner can't store or remove", async () => {
    assert.equal((await send(MEMBER, "PUT", url(DIR, "object", "a.txt"), "x")).status, 403);
    await send(OWNER, "PUT", url(DIR, "object", "a.txt"), "x");
    assert.equal((await send(MEMBER, "DELETE", url(DIR, "object", "a.txt"))).status, 403);
    assert.equal((await send(MEMBER, "DELETE", url(DIR, "all"))).status, 403);
    assert.ok(objects.has(key(DIR, "a.txt")));
  });

  test("outsiders, other projects and unapproved items are 404", async () => {
    assert.equal((await send(STRANGER, "PUT", url(DIR, "object", "a.txt"), "x")).status, 404);
    assert.equal((await send(STRANGER, "GET", url(DIR, "list"))).status, 404);
    assert.equal((await send(OWNER, "PUT", url(PENDING, "object", "a.txt"), "x")).status, 404);
    assert.equal((await send(OWNER, "PUT", url(DIR, "object", "a.txt", OTHER_PROJECT), "x")).status, 404);
    assert.equal(objects.size, 0);
  });

  test("bad ids and paths are refused before anything is stored", async () => {
    assert.equal((await send(OWNER, "PUT", `/api/projects/not-a-uuid/files/${DIR}/object?path=a`, "x")).status, 400);
    assert.equal((await send(OWNER, "PUT", `/api/projects/${PROJECT}/files/..%2f..%2fx/object?path=a`, "x")).status, 400);
    for (const p of ["../x", "/abs", "a/../../b", ".env", "src/.git/config", "node_modules/x", "a\\b", "c:x", "", "a//b"]) {
      assert.equal((await send(OWNER, "PUT", url(DIR, "object", p), "x")).status, 400, p);
    }
    assert.equal(objects.size, 0);
  });

  test("a file over the limit is refused by its declared length", async () => {
    const r = await app.request(url(DIR, "object", "big.bin"), { method: "PUT", headers: { "x-user": OWNER, "content-length": String(26 * 1024 * 1024) }, body: "x" });
    assert.equal(r.status, 413);
    assert.equal(objects.size, 0);
  });

  test("a project at its limit stores nothing more; replacing a file counts only the growth", async () => {
    usageOverride = { bytes: LIMITS.projectBytes - 3, files: 10 };
    assert.equal((await send(OWNER, "PUT", url(DIR, "object", "a.txt"), "12345")).status, 409);
    assert.equal((await send(OWNER, "PUT", url(DIR, "object", "a.txt"), "123")).status, 200);
    usageOverride = null; // more files than can be counted
    assert.equal((await send(OWNER, "PUT", url(DIR, "object", "b.txt"), "1")).status, 409);
  });

  test("a text file that holds a secret is not stored, a binary one is not scanned", async () => {
    const secret = `const k = "sk-${"a1B2".repeat(10)}";`;
    const r = await send(OWNER, "PUT", url(DIR, "object", "config.ts"), secret);
    assert.equal(r.status, 422);
    assert.equal(((await r.json()) as { code: string }).code, "secrets");
    assert.equal(objects.size, 0);
    assert.equal((await send(OWNER, "PUT", url(DIR, "object", "ok.ts"), "const k = process.env.KEY;")).status, 200);
    const binary = new Uint8Array([0, 1, 2, ...new TextEncoder().encode(secret)]);
    assert.equal((await send(OWNER, "PUT", url(DIR, "object", "pic.png"), binary)).status, 200);
  });

  test("storage not set up answers 503 with a code, naming nothing secret", async () => {
    offline = true;
    const r = await send(OWNER, "PUT", url(DIR, "object", "a.txt"), "x");
    assert.equal(r.status, 503);
    const body = (await r.json()) as { code: string; error: string };
    assert.equal(body.code, "storage_off");
    assert.doesNotMatch(body.error, /R2_/);
  });
});

describe("reading files", () => {
  beforeEach(async () => {
    for (const p of ["README.md", "src/a.ts", "src/b.ts", "src/deep/c.ts"]) await send(OWNER, "PUT", url(DIR, "object", p), p);
    await send(OWNER, "PUT", url(FILE, "object", "notes.md"), "notes");
  });

  test("any member lists the top level, folders first", async () => {
    const r = await send(MEMBER, "GET", url(DIR, "list"));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      path: "",
      entries: [
        { name: "src", kind: "dir", bytes: 0, modified: null },
        { name: "README.md", kind: "file", bytes: 9, modified: "2026-10-23T12:00:00.000Z" },
      ],
      truncated: false,
    });
  });

  test("lists inside a folder, and an item that is one file lists just it", async () => {
    const inner = (await (await send(MEMBER, "GET", url(DIR, "list", "src"))).json()) as { entries: { name: string }[] };
    assert.deepEqual(inner.entries.map((e) => e.name), ["deep", "a.ts", "b.ts"]);
    const one = (await (await send(MEMBER, "GET", url(FILE, "list"))).json()) as { entries: { name: string }[] };
    assert.deepEqual(one.entries.map((e) => e.name), ["notes.md"]);
  });

  test("a download is a short-lived address, not the bytes", async () => {
    const r = await send(MEMBER, "GET", url(DIR, "object", "src/a.ts"));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.deepEqual(await r.json(), { url: `https://r2.example/${key(DIR, "src/a.ts")}?name=a.ts&expires=60`, bytes: 8, modified: "2026-10-23T12:00:00.000Z", expiresInSeconds: 60 });
  });

  test("a file that isn't stored is 404, and a bad path is 400", async () => {
    assert.equal((await send(MEMBER, "GET", url(DIR, "object", "none.txt"))).status, 404);
    assert.equal((await send(MEMBER, "GET", url(DIR, "object", "../x"))).status, 400);
    assert.equal((await send(MEMBER, "GET", url(DIR, "list", ".git"))).status, 400);
  });

  test("the owner removes one file or all of an item; other items stay", async () => {
    assert.equal((await send(OWNER, "DELETE", url(DIR, "object", "src/a.ts"))).status, 200);
    assert.ok(!objects.has(key(DIR, "src/a.ts")));
    const all = await send(OWNER, "DELETE", url(DIR, "all"));
    assert.deepEqual(await all.json(), { ok: true, removed: 3 });
    assert.deepEqual([...objects.keys()], [key(FILE, "notes.md")]);
  });
});
