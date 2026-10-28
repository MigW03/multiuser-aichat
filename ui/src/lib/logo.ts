// The Nido mark: a nest seen from above (one ring) with three eggs. The ring carries the accent colour, the eggs carry the ink colour.
// Everything that draws the mark goes through here, so the in-app logo, the favicon and the exported brand files stay identical.

export const LOGO_VIEWBOX = "0 0 64 64";
export const LOGO_RING = { cx: 32, cy: 32, r: 27, stroke: 4.5 } as const;
export const LOGO_EGG_RADIUS = 7;
// Centres of the three eggs: 10 units from the middle at -90, 30 and 150 degrees.
export const LOGO_EGGS = [
  [32, 22],
  [40.7, 37],
  [23.3, 37],
] as const;

/** Dark ink used for the eggs on light backgrounds, and its light counterpart on dark ones (the app's fg tokens). */
export const LOGO_INK = { light: "#1f241b", dark: "#ebeee6" } as const;

const HEX = /^#[0-9a-f]{6}$/i;

/** Colours end up inside SVG markup, so only plain 6-digit hex is accepted. */
function hex(color: string): string {
  if (!HEX.test(color)) throw new Error(`Not a 6-digit hex colour: ${color}`);
  return color.toLowerCase();
}

/** The circles of the mark. `ring` and `egg` are any paint the caller trusts, e.g. "var(--p)" inside the app. */
export function logoShapes(ring: string, egg: string): string {
  const { cx, cy, r, stroke } = LOGO_RING;
  const eggs = LOGO_EGGS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${LOGO_EGG_RADIUS}" fill="${egg}"/>`).join("");
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ring}" stroke-width="${stroke}"/>${eggs}`;
}

/** A standalone SVG file of the mark in plain colours. */
export function logoSvg(ringHex: string, eggHex: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LOGO_VIEWBOX}">${logoShapes(hex(ringHex), hex(eggHex))}</svg>`;
}

/** The favicon: ring in the accent, eggs in ink that flips to light when the browser is in dark mode. */
export function faviconSvg(accent: string): string {
  const ring = hex(accent);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LOGO_VIEWBOX}">` +
    `<style>.e{fill:${LOGO_INK.light}}@media (prefers-color-scheme:dark){.e{fill:${LOGO_INK.dark}}}</style>` +
    logoShapes(ring, LOGO_INK.light).replace(/fill="#1f241b"/g, 'class="e"') +
    `</svg>`
  );
}

export const faviconHref = (accent: string): string => `data:image/svg+xml,${encodeURIComponent(faviconSvg(accent))}`;

/** Sage tile with a cream ring and ink eggs: the app icon and the touch icon. `radius` is the corner radius in a 1024 box (0 = square). */
export function appIconSvg(accent: string, radius = 230): string {
  const tile = hex(accent);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">` +
    `<rect width="1024" height="1024" rx="${radius}" fill="${tile}"/>` +
    `<g transform="translate(192 192) scale(10)">${logoShapes("#f1f1e8", LOGO_INK.light)}</g>` +
    `</svg>`
  );
}
