import { connect } from "node:net";

export type Bounds = { x: number; y: number; width: number; height: number };

const MAX_COORD = 20_000;

/** A rectangle from the page: whole, in range, or null. */
export function cleanBounds(raw: unknown): Bounds | null {
  const b = raw as Partial<Record<keyof Bounds, unknown>> | null;
  if (!b || typeof b !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(MAX_COORD, Math.max(0, v))) : null);
  const x = n(b.x);
  const y = n(b.y);
  const width = n(b.width);
  const height = n(b.height);
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
}

/** Whether something accepts connections at this port on this computer (IPv4 or IPv6: dev servers bind to either). */
export function portOpen(port: number, timeoutMs = 400): Promise<boolean> {
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ port, host });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  return Promise.all([tryHost("127.0.0.1"), tryHost("::1")]).then(([a, b]) => a || b);
}

