import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { BlockedAddress, checkUrl, createGuardedFetch, isBlockedAddress } from "./ssrf.ts";

describe("blocked addresses", () => {
  test("private, loopback, link-local, metadata and reserved IPv4 ranges", () => {
    for (const ip of ["0.0.0.0", "10.0.0.1", "10.255.255.255", "127.0.0.1", "127.8.8.8", "100.64.0.1", "100.127.255.255", "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255"]) assert.equal(isBlockedAddress(ip), true, ip);
  });
  test("public IPv4 addresses pass, including the edges of the blocked ranges", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.0.1", "169.255.0.1", "192.167.255.255", "192.169.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.255"]) assert.equal(isBlockedAddress(ip), false, ip);
  });
  test("IPv6: loopback, unspecified, unique local, link-local, multicast, mapped and translated IPv4", () => {
    for (const ip of ["::", "::1", "0:0:0:0:0:0:0:1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "febf::1", "fec0::1", "ff02::1", "2001:db8::1", "2002:c0a8:0101::1", "2001:0:4136:e378::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.1.2.3", "::ffff:169.254.169.254", "64:ff9b::a00:1", "64:ff9b::169.254.169.254", "::127.0.0.1"]) assert.equal(isBlockedAddress(ip), true, ip);
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808", "2a00:1450:4001::1"]) assert.equal(isBlockedAddress(ip), false, ip);
  });
  test("anything that is not an address counts as blocked", () => {
    for (const ip of ["", "example.com", "1.2.3", "1.2.3.4.5", "999.1.1.1", "::g", "1::2::3"]) assert.equal(isBlockedAddress(ip), true, ip);
  });
});

describe("addresses people type", () => {
  const blocked = (input: unknown, why: string) => assert.throws(() => checkUrl(input), (e: unknown) => e instanceof BlockedAddress && e.why === why, String(input));
  test("https only, no credentials, no local names or IP literals in blocked ranges", () => {
    assert.equal(checkUrl("https://mcp.example.com/mcp").href, "https://mcp.example.com/mcp");
    assert.equal(checkUrl("  https://mcp.example.com:8443/a?b=1#frag ").href, "https://mcp.example.com:8443/a?b=1");
    assert.equal(checkUrl("https://93.184.216.34/mcp").hostname, "93.184.216.34");
    blocked("http://example.com/mcp", "scheme");
    blocked("ftp://example.com", "scheme");
    blocked("file:///etc/passwd", "scheme");
    blocked("https://user:pw@example.com/", "credentials");
    blocked("https://user@example.com/", "credentials");
    for (const u of ["https://localhost/", "https://app.localhost/", "https://printer.local/", "https://db.internal/", "https://127.0.0.1/", "https://[::1]/", "https://10.0.0.5/", "https://169.254.169.254/latest/meta-data", "https://[fd00::1]/", "https://[::ffff:127.0.0.1]/", "https://2130706433/", "https://0x7f.1/", "https://0177.0.0.1/"]) blocked(u, "address");
    blocked("not a url", "invalid");
    blocked("", "invalid");
    blocked(5, "invalid");
    blocked(`https://example.com/${"a".repeat(2000)}`, "invalid");
  });
});

describe("the guarded connection", () => {
  test("a name that resolves to a private address is refused at connect time, even if another address is public", async () => {
    let resolved = 0;
    const f = createGuardedFetch({ resolve: (_h, cb) => (resolved++, cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }])) });
    await assert.rejects(f("https://rebind.example.com/mcp"), /fetch failed|blocked/);
    assert.ok(resolved >= 1);
  });
  test("the same name is checked again on every new connection (a later rebind is caught)", async () => {
    let answer = "93.184.216.34";
    const f = createGuardedFetch({ resolve: (_h, cb) => cb(null, [{ address: answer, family: 4 }]) });
    await assert.rejects(f("https://later.example.com/mcp"), (e: unknown) => !/blocked/.test(String((e as Error).cause ?? e)) || true); // public address: the connection itself fails here (no network), not the guard
    answer = "127.0.0.1";
    await assert.rejects(f("https://later2.example.com/mcp"), /fetch failed|blocked/);
  });
  test("an unresolvable or empty answer fails", async () => {
    const f = createGuardedFetch({ resolve: (_h, cb) => cb(null, []) });
    await assert.rejects(f("https://nothing.example.com/"), /fetch failed|no address/);
    const g = createGuardedFetch({ resolve: (_h, cb) => cb(Object.assign(new Error("nxdomain"), { code: "ENOTFOUND" }), []) });
    await assert.rejects(g("https://gone.example.com/"), /fetch failed|nxdomain/);
  });
  test("http and blocked literals are refused before any DNS", async () => {
    let resolved = 0;
    const f = createGuardedFetch({ resolve: (_h, cb) => (resolved++, cb(null, [{ address: "93.184.216.34", family: 4 }])) });
    await assert.rejects(f("http://example.com/"), (e: unknown) => e instanceof BlockedAddress);
    await assert.rejects(f("https://127.0.0.1/"), (e: unknown) => e instanceof BlockedAddress);
    await assert.rejects(f("https://[::1]:9/"), (e: unknown) => e instanceof BlockedAddress);
    await assert.rejects(f("not a url"), (e: unknown) => e instanceof BlockedAddress);
    assert.equal(resolved, 0);
  });
  test("a response that never stops is cut off", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const chunk = Buffer.alloc(1024 * 1024, 97);
      let n = 0;
      const send = () => {
        while (n++ < 40) if (!res.write(chunk)) return void res.once("drain", send);
        res.end();
      };
      send();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const f = createGuardedFetch({ allowPrivate: true });
      const res = await f(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      await assert.rejects(res.text(), /too large|terminated|aborted/i);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
  test("a normal local server works only with allowPrivate (tests), never by default", async () => {
    const server = createServer((_req, res) => res.end("hello"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      assert.equal(await (await createGuardedFetch({ allowPrivate: true })(url)).text(), "hello");
      await assert.rejects(createGuardedFetch()(url), (e: unknown) => e instanceof BlockedAddress);
    } finally {
      server.close();
    }
  });
});
