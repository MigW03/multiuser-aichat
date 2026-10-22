import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Item } from "./folder-items.ts";
import { createRunServer, RUN_CSP, type RunServer } from "./run-server.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let run: RunServer;
let items: Item[] = [];
let page = "";
let origin = "";

/** A GET with full control of the Host header (fetch does not allow setting it). */
function get(url: string, opts: { host?: string; method?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((ok, bad) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? "GET", headers: { host: opts.host ?? u.host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", bad);
    req.end();
  });
}

before(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mc-run-")));
  const outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "outside the shared folder");
  const root = join(base, "my app");
  mkdirSync(join(root, "site/img"), { recursive: true });
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "site/index.html"), "<h1>Hello</h1><script src=app.js></script>");
  writeFileSync(join(root, "site/app.js"), "document.title='ran'");
  writeFileSync(join(root, "site/style.css"), "h1{color:red}");
  writeFileSync(join(root, "site/img/dot.png"), Buffer.from([137, 80, 78, 71, 0, 1, 2]));
  writeFileSync(join(root, "docs/index.html"), "<p>docs index</p>");
  writeFileSync(join(root, "site/data.weird"), "x");
  writeFileSync(join(root, ".env"), "SECRET=1");
  writeFileSync(join(root, ".git/config"), "x");
  writeFileSync(join(root, "dist/out.js"), "x");
  writeFileSync(join(root, "key.pem"), "x");
  symlinkSync(outside, join(root, "link"));
  symlinkSync(join(outside, "secret.txt"), join(root, "site/secret-link.txt"));
  writeFileSync(join(base, "single.html"), "<p>single</p>");
  writeFileSync(join(base, "sibling.txt"), "not shared");
  items = [
    { abs: root, kind: "dir", name: "my app" },
    { abs: join(base, "single.html"), kind: "file", name: "single.html" },
  ];
  run = createRunServer();
  run.setItems((id) => (id === PROJECT ? items : []));
  page = await run.urlFor(PROJECT, "my app/site/index.html");
  origin = new URL(page).origin;
});

after(() => run.stop());

const under = (path: string) => `${page.slice(0, page.indexOf("/my%20app/"))}/${path}`;

describe("run server", () => {
  test("serves an HTML page with the policy and safe headers", async () => {
    const r = await get(page);
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), "<h1>Hello</h1><script src=app.js></script>");
    assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(r.headers["content-security-policy"], RUN_CSP);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    assert.equal(r.headers["x-frame-options"], "DENY");
  });

  test("the policy lets a page use this server only", () => {
    assert.match(RUN_CSP, /^default-src 'none'/);
    for (const d of ["script-src", "style-src", "img-src", "font-src", "connect-src"]) assert.match(RUN_CSP, new RegExp(`${d} 'self'`));
    assert.ok(!/https?:|\*/.test(RUN_CSP), "no remote source allowed");
    assert.match(RUN_CSP, /form-action 'none'/);
    assert.match(RUN_CSP, /frame-ancestors 'none'/);
    assert.match(RUN_CSP, /object-src 'none'/);
    assert.ok(!/unsafe-eval/.test(RUN_CSP));
  });

  test("serves the files next to it with their types, relative to the page", async () => {
    const css = await get(new URL("style.css", page).href);
    assert.equal(css.status, 200);
    assert.equal(css.headers["content-type"], "text/css; charset=utf-8");
    const js = await get(new URL("app.js", page).href);
    assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
    const png = await get(new URL("img/dot.png", page).href);
    assert.equal(png.status, 200);
    assert.equal(png.headers["content-type"], "image/png");
    assert.deepEqual([...png.body], [137, 80, 78, 71, 0, 1, 2]);
    assert.equal((await get(new URL("data.weird", page).href)).headers["content-type"], "application/octet-stream");
  });

  test("a folder address serves its index.html", async () => {
    const r = await get(under("my%20app/docs/"));
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), "<p>docs index</p>");
    assert.equal((await get(under("my%20app/docs"))).status, 200);
    assert.equal((await get(under("my%20app/site/img"))).status, 404, "a folder without index.html");
  });

  test("HEAD works, other methods do not", async () => {
    const head = await get(page, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) assert.equal((await get(page, { method })).status, 405, method);
  });

  test("an address without the token, or with a wrong one, gets nothing", async () => {
    assert.equal((await get(`${origin}/my%20app/site/index.html`)).status, 404);
    assert.equal((await get(`${origin}/`)).status, 404);
    assert.equal((await get(`${origin}/wrong-token/my%20app/site/index.html`)).status, 404);
  });

  test("another Host header is refused (DNS rebinding)", async () => {
    for (const host of ["evil.example", "localhost:" + new URL(page).port, "127.0.0.1", "127.0.0.1:1"]) assert.equal((await get(page, { host })).status, 403, host);
  });

  test("secrets, keys, git and build output are never served", async () => {
    for (const p of [".env", ".git/config", "dist/out.js", "key.pem"]) assert.equal((await get(under(`my%20app/${p}`))).status, 404, p);
  });

  test("symlinks are not followed", async () => {
    assert.equal((await get(under("my%20app/link/secret.txt"))).status, 404);
    assert.equal((await get(under("my%20app/site/secret-link.txt"))).status, 404);
  });

  test("a path cannot climb out, however it is written", async () => {
    for (const p of ["my%20app/../outside/secret.txt", "my%20app/site/..%2f..%2foutside/secret.txt", "my%20app/%2e%2e/outside/secret.txt", "my%20app/site/%2e%2e/%2e%2e/%2e%2e/outside/secret.txt", "my%20app/site%5c..%5c..%5coutside", "%2e%2e/outside/secret.txt"]) {
      const r = await get(under(p));
      assert.ok(r.status === 404 || r.status === 400, `${p} gave ${r.status}`);
      assert.ok(!r.body.toString().includes("outside the shared folder"), p);
    }
  });

  test("bad encodings and control characters are refused", async () => {
    for (const p of ["my%20app/%zz", "my%20app/site%00/index.html", "my%20app/site%0a/index.html"]) {
      const r = await get(under(p));
      assert.ok(r.status === 404 || r.status === 400, `${p} gave ${r.status}`);
    }
  });

  test("only the items of this project, and only what is approved right now", async () => {
    const otherPage = await run.urlFor(OTHER, "my app/site/index.html");
    assert.equal((await get(otherPage)).status, 404, "a project with nothing shared");
    const kept = items;
    items = [];
    assert.equal((await get(page)).status, 404, "an item that is no longer shared");
    items = kept;
    assert.equal((await get(page)).status, 200);
  });

  test("a single shared file is served alone, not its neighbours", async () => {
    const one = await get(under("single.html"));
    assert.equal(one.status, 200);
    assert.equal(one.body.toString(), "<p>single</p>");
    assert.equal((await get(under("sibling.txt"))).status, 404);
    assert.equal((await get(under("single.html/x"))).status, 404);
  });

  test("owns() knows its own addresses and nothing else", () => {
    assert.ok(run.owns(page));
    assert.ok(run.owns(new URL("style.css", page).href));
    assert.ok(!run.owns(`${origin}/nope/x`));
    assert.ok(!run.owns(origin + "/"));
    assert.ok(!run.owns("http://127.0.0.1:1/x"));
    assert.ok(!run.owns("https://example.com/"));
    assert.ok(!run.owns("not a url"));
    assert.equal(run.origin(), origin);
  });

  test("it listens on 127.0.0.1 only", () => {
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("stop() closes the server and forgets the tokens", async () => {
    const second = createRunServer();
    second.setItems(() => items);
    const url = await second.urlFor(PROJECT, "my app/site/index.html");
    assert.equal((await get(url)).status, 200);
    second.stop();
    assert.ok(!second.owns(url));
    assert.equal(second.origin(), null);
    await assert.rejects(get(url));
    // and it can start again with a new address and a new token
    const again = await second.urlFor(PROJECT, "my app/site/index.html");
    assert.notEqual(again, url);
    assert.equal((await get(again)).status, 200);
    second.stop();
  });
});
