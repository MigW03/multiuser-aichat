import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

// The chat server connects to MCP servers at addresses people type in. That makes the server fetch URLs for users, so
// it must never reach the server's own network: localhost, private ranges, link-local (cloud metadata lives at
// 169.254.169.254), and the IPv6 equivalents.
//
// Two layers. `checkUrl` rejects an address that is not https, has credentials, or is an IP literal in a blocked range.
// `guardedFetch` resolves the name itself and refuses to connect when ANY resolved address is blocked, at connect time on
// every request (so a name that resolves to a public address when it is added and to a private one later, "DNS
// rebinding", is caught too). Redirects are left to the MCP SDK, which only follows same-origin ones; a redirect still
// goes through the same guarded connect. Response bodies are capped.

export class BlockedAddress extends Error {
  constructor(readonly why: "scheme" | "credentials" | "address" | "invalid" | "port") {
    super(`blocked: ${why}`);
  }
}

// ------------------------------------------------------------------ addresses

function v4Bytes(ip: string): number[] | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
}

/** An IPv6 address as 16 bytes, or null. Handles "::" and an embedded IPv4 tail. */
function v6Bytes(ip: string): number[] | null {
  let s = ip.split("%")[0]!.toLowerCase();
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = v4Bytes(tail[1]!);
    if (!v4) return null;
    s = s.slice(0, -tail[1]!.length) + ((v4[0]! << 8) | v4[1]!).toString(16) + ":" + ((v4[2]! << 8) | v4[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves[1] !== undefined && halves[1] !== "" ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

function blockedV4(b: number[]): boolean {
  const [a, c, d] = b as [number, number, number, number];
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && c >= 64 && c <= 127) || // carrier-grade NAT
    (a === 169 && c === 254) || // link-local, cloud metadata
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 0 && d === 0) || // IETF protocol assignments
    (a === 192 && c === 0 && d === 2) || // documentation
    (a === 192 && c === 168) ||
    (a === 198 && (c === 18 || c === 19)) || // benchmarking
    (a === 198 && c === 51 && d === 100) ||
    (a === 203 && c === 0 && d === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** True for an address the server must not connect to. Anything that is not a valid address counts as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip.split("%")[0]!);
  if (kind === 4) {
    const b = v4Bytes(ip);
    return !b || blockedV4(b);
  }
  if (kind === 6) {
    const b = v6Bytes(ip);
    if (!b) return true;
    const first10Zero = b.slice(0, 10).every((x) => x === 0);
    if (first10Zero && b[10] === 0 && b[11] === 0) return true; // :: and ::1 and IPv4-compatible
    if (first10Zero && b[10] === 255 && b[11] === 255) return blockedV4(b.slice(12)); // ::ffff:a.b.c.d
    if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return blockedV4(b.slice(12)); // 64:ff9b::/96 NAT64
    if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
    if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
    if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
    if (b[0] === 0xff) return true; // multicast
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
    if (b[0] === 0x20 && b[1] === 0x02) return true; // 2002::/16 6to4 (embeds an IPv4 we cannot trust)
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // 2001::/32 Teredo
    return false;
  }
  return true;
}

// ------------------------------------------------------------------ addresses people type

/** The address of an MCP server: https only, no credentials in it, not an IP literal in a blocked range. Returns it parsed. */
export function checkUrl(input: unknown): URL {
  if (typeof input !== "string" || input.length > 2000) throw new BlockedAddress("invalid");
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new BlockedAddress("invalid");
  }
  if (u.protocol !== "https:") throw new BlockedAddress("scheme");
  if (u.username || u.password) throw new BlockedAddress("credentials");
  if (!u.hostname) throw new BlockedAddress("invalid");
  const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  if (isIP(host) && isBlockedAddress(host)) throw new BlockedAddress("address");
  // A name that is plainly local never reaches DNS.
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/i.test(host)) throw new BlockedAddress("address");
  u.hash = "";
  return u;
}

// ------------------------------------------------------------------ the guarded connection

type Resolve = (hostname: string, cb: (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void) => void;

const defaultResolve: Resolve = (hostname, cb) => dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => cb(err, addresses ?? []));

/** Largest response body kept in memory: tool lists and results are small; this stops a server that never stops sending. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function limitBody(res: Response): Response {
  if (!res.body) return res;
  let seen = 0;
  const limited = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > MAX_BODY_BYTES) controller.error(new Error("response too large"));
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(limited, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * A fetch for MCP traffic. Every connection it makes resolves the name and refuses blocked addresses. `allowPrivate` is
 * for tests that talk to a server on this machine; production code never sets it.
 */
export function createGuardedFetch(opts: { resolve?: Resolve; allowPrivate?: boolean } = {}): typeof fetch {
  const resolve = opts.resolve ?? defaultResolve;
  const agent = new Agent({
    connect: {
      timeout: 15_000,
      // undici calls this for every new connection to a hostname (not for IP literals, which checkUrl handled).
      lookup: (hostname: string, options: { all?: boolean }, cb: (err: Error | null, address?: unknown, family?: number) => void) => {
        resolve(hostname, (err, addresses) => {
          if (err) return cb(err);
          if (addresses.length === 0) return cb(new Error("no address"));
          if (!opts.allowPrivate && addresses.some((a) => isBlockedAddress(a.address))) return cb(new BlockedAddress("address"));
          if (options.all) return cb(null, addresses);
          cb(null, addresses[0]!.address, addresses[0]!.family);
        });
      },
    },
    headersTimeout: 60_000,
    bodyTimeout: 120_000,
    maxRedirections: 0,
  } as ConstructorParameters<typeof Agent>[0]);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = (() => {
      try {
        return new URL(url);
      } catch {
        throw new BlockedAddress("invalid");
      }
    })();
    if (u.protocol !== "https:" && !opts.allowPrivate) throw new BlockedAddress("scheme");
    if (!opts.allowPrivate) checkUrl(u.href);
    const res = await undiciFetch(url, { ...(init as object), dispatcher: agent } as never);
    return limitBody(res as unknown as Response);
  }) as typeof fetch;
}

export const guardedFetch = createGuardedFetch();
