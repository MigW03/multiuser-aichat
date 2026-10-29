import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

// The environment module reads these when it loads.
process.env.SUPABASE_URL ??= "http://localhost:54399";
process.env.SUPABASE_SECRET_KEY ??= "test";
process.env.KEY_ENCRYPTION_SECRET ??= Buffer.alloc(32, 7).toString("base64");
process.env.APP_URL ??= "http://localhost:5173";

const KEY_ID = "test-key-id";
const SECRET = "test-secret-never-logged";
const BUCKET = "nido-test";

type Stored = { body: Buffer; headers: IncomingMessage["headers"]; modified: Date };
const objects = new Map<string, Stored>();
const seen: { method: string; url: string; auth: string | undefined }[] = [];
let server: Server;
let endpoint: string;
let createR2Store: typeof import("./r2.ts").createR2Store;

const xml = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?>${inner}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

before(async () => {
  ({ createR2Store } = await import("./r2.ts"));
  // A small S3 look-alike: path-style addressing, put / head / get / delete, list v2 and multi-delete.
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
    const [, bucket, ...rest] = url.pathname.split("/");
    const key = decodeURIComponent(rest.join("/"));
    if (bucket !== BUCKET) return void res.writeHead(404).end();
    const data = await body(req);
    if (req.method === "PUT") {
      objects.set(key, { body: data, headers: req.headers, modified: new Date("2026-10-23T12:00:00Z") });
      return void res.writeHead(200, { etag: '"x"' }).end();
    }
    if (req.method === "HEAD") {
      const o = objects.get(key);
      return void res.writeHead(o ? 200 : 404, o ? { "content-length": String(o.body.length), "last-modified": o.modified.toUTCString() } : {}).end();
    }
    if (req.method === "DELETE") {
      objects.delete(key);
      return void res.writeHead(204).end();
    }
    if (req.method === "POST" && url.searchParams.has("delete")) {
      for (const m of data.toString().matchAll(/<Key>([^<]*)<\/Key>/g)) objects.delete(m[1]!.replace(/&lt;/g, "<").replace(/&amp;/g, "&"));
      return void res.writeHead(200, { "content-type": "application/xml" }).end(xml("<DeleteResult/>"));
    }
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const delimiter = url.searchParams.get("delimiter");
      const max = Number(url.searchParams.get("max-keys") ?? 1000);
      const after = url.searchParams.get("continuation-token") ?? "";
      const files: string[] = [];
      const dirs = new Set<string>();
      for (const k of [...objects.keys()].sort()) {
        if (!k.startsWith(prefix) || k <= after) continue;
        const slash = delimiter ? k.indexOf(delimiter, prefix.length) : -1;
        if (slash >= 0) dirs.add(k.slice(0, slash + 1));
        else files.push(k);
      }
      const page = files.slice(0, max);
      const truncated = files.length > max;
      return void res.writeHead(200, { "content-type": "application/xml" }).end(
        xml(
          `<ListBucketResult><Name>${BUCKET}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>` +
            (truncated ? `<NextContinuationToken>${esc(page[page.length - 1]!)}</NextContinuationToken>` : "") +
            page.map((k) => `<Contents><Key>${esc(k)}</Key><LastModified>2026-10-23T12:00:00.000Z</LastModified><Size>${objects.get(k)!.body.length}</Size></Contents>`).join("") +
            [...dirs].map((d) => `<CommonPrefixes><Prefix>${esc(d)}</Prefix></CommonPrefixes>`).join("") +
            "</ListBucketResult>",
        ),
      );
    }
    if (req.method === "GET") {
      const o = objects.get(key);
      return void res.writeHead(o ? 200 : 404).end(o?.body);
    }
    res.writeHead(400).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

const store = () => createR2Store({ accessKeyId: KEY_ID, secretAccessKey: SECRET, endpoint, bucket: BUCKET });

describe("R2 store", () => {
  test("stores an object as a download, signed with the account's key", async () => {
    objects.clear();
    seen.length = 0;
    await store().put("projects/p/s/a.txt", new TextEncoder().encode("hello"), { uploader: "u1" });
    const o = objects.get("projects/p/s/a.txt")!;
    assert.equal(o.body.toString(), "hello");
    assert.equal(o.headers["content-type"], "application/octet-stream");
    assert.equal(o.headers["content-disposition"], "attachment");
    assert.equal(o.headers["x-amz-meta-uploader"], "u1");
    assert.match(seen[0]!.auth ?? "", new RegExp(`^AWS4-HMAC-SHA256 Credential=${KEY_ID}/\\d{8}/auto/s3/aws4_request`));
    assert.ok(!seen.some((r) => r.url.includes(SECRET)), "the secret is never sent");
  });

  test("head: size, time, and null when missing", async () => {
    assert.deepEqual(await store().head("projects/p/s/a.txt"), { key: "projects/p/s/a.txt", bytes: 5, modified: "2026-10-23T12:00:00.000Z" });
    assert.equal(await store().head("projects/p/s/none.txt"), null);
  });

  test("get: the bytes, null when missing, refused above the limit", async () => {
    const got = await store().get("projects/p/s/a.txt", 100);
    assert.equal(new TextDecoder().decode(got!), "hello");
    assert.equal(await store().get("projects/p/s/none.txt", 100), null);
    await assert.rejects(store().get("projects/p/s/a.txt", 3), /larger than allowed/);
  });

  test("list: files and folders directly under a prefix", async () => {
    objects.clear();
    const s = store();
    for (const k of ["projects/p/s/a.txt", "projects/p/s/b.txt", "projects/p/s/src/x.ts", "projects/p/s/src/deep/y.ts", "projects/p/other/z.txt"]) await s.put(k, new Uint8Array(3));
    const top = await s.list("projects/p/s/", 100);
    assert.deepEqual(top.files.map((f) => f.key), ["projects/p/s/a.txt", "projects/p/s/b.txt"]);
    assert.deepEqual(top.dirs, ["projects/p/s/src/"]);
    assert.equal(top.truncated, false);
    const cut = await s.list("projects/p/s/", 1);
    assert.equal(cut.truncated, true);
  });

  test("usage counts everything under a prefix, and gives up above the limit", async () => {
    const s = store();
    assert.deepEqual(await s.usage("projects/p/", 10), { bytes: 15, files: 5 });
    assert.equal(await s.usage("projects/p/", 3), null);
    assert.deepEqual(await s.usage("projects/nobody/", 10), { bytes: 0, files: 0 });
  });

  test("removePrefix removes only that prefix; remove removes one", async () => {
    const s = store();
    assert.equal(await s.removePrefix("projects/p/s/"), 4);
    assert.deepEqual([...objects.keys()], ["projects/p/other/z.txt"]);
    await assert.rejects(s.removePrefix("projects/p"), /ends in/);
    await s.remove("projects/p/other/z.txt");
    assert.equal(objects.size, 0);
  });

  test("a download address expires, is signed, and forces a save", async () => {
    objects.clear();
    await store().put("projects/p/s/page.html", new TextEncoder().encode("<script>alert(1)</script>"));
    const url = new URL(await store().downloadUrl("projects/p/s/page.html", "pa ge's (1).html", 60));
    assert.equal(url.origin, endpoint);
    assert.equal(url.pathname, `/${BUCKET}/projects/p/s/page.html`);
    assert.equal(url.searchParams.get("X-Amz-Expires"), "60");
    assert.ok(url.searchParams.get("X-Amz-Signature"));
    assert.ok(!url.toString().includes(SECRET));
    assert.equal(url.searchParams.get("response-content-type"), "application/octet-stream");
    assert.equal(url.searchParams.get("response-content-disposition"), "attachment; filename*=UTF-8''pa%20ge%27s%20%281%29.html");
    assert.equal((await fetch(url)).status, 200);
  });
});

describe("configuration", () => {
  test("names the missing variables, never their values", async () => {
    const { r2ConfigFromEnv, storageOn, StorageOffError } = await import("./r2.ts");
    assert.equal(storageOn(), false);
    try {
      r2ConfigFromEnv();
      assert.fail("should throw");
    } catch (e) {
      assert.ok(e instanceof StorageOffError);
      assert.deepEqual(e.missing, ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT", "R2_BUCKET"]);
      assert.match(e.message, /R2_BUCKET/);
    }
  });
});
