import { useEffect, useState } from "react";
import { LOGO_EGG_RADIUS, LOGO_EGGS, LOGO_RING, LOGO_VIEWBOX } from "../lib/logo.ts";

/** Seconds since this showed up. Starts counting after a short wait, so quick answers show no timer. */
export function useElapsed(showAfter = 3): number | null {
  const [s, setS] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setS((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return s >= showAfter ? s : null;
}

/** The Nido mark while the AI starts answering: the ring stays, the three eggs light up one after another. */
export function EggLoader({ size = 24 }: { size?: number }) {
  return (
    <svg className="egg-loader" width={size} height={size} viewBox={LOGO_VIEWBOX} aria-hidden>
      <circle cx={LOGO_RING.cx} cy={LOGO_RING.cy} r={LOGO_RING.r} fill="none" stroke="var(--p)" strokeWidth={LOGO_RING.stroke} />
      {LOGO_EGGS.map(([x, y], i) => (
        <circle key={i} className="egg" style={{ animationDelay: `${i * 0.5}s` }} cx={x} cy={y} r={LOGO_EGG_RADIUS} fill="var(--fg)" />
      ))}
    </svg>
  );
}
