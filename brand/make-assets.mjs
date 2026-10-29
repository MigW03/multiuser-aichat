// Regenerates every logo file from the mark defined in ui/src/lib/logo.ts.
//   npx tsx brand/make-assets.mjs        (needs Playwright with Chromium installed; it is not a project dependency)
// Writes: brand/*.svg and *.png, web/public/{favicon.svg,favicon.ico,apple-touch-icon.png}, desktop/build/icon.png, site/assets/{icon.svg,favicon.svg}.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { appIconSvg, faviconSvg, LOGO_INK, logoSvg } from "../ui/src/lib/logo.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SAGE = "#9db38f";
const out = (p, data) => {
  const f = resolve(root, p);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, data);
};

const browser = await chromium.launch();
const page = await browser.newPage();
async function png(svg, size, transparent = true) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  return page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
}

// Plain SVG marks
out("brand/logo-mark.svg", logoSvg(SAGE, LOGO_INK.light));
out("brand/logo-mark-dark.svg", logoSvg(SAGE, LOGO_INK.dark));
out("brand/app-icon.svg", appIconSvg(SAGE));
out("web/public/favicon.svg", faviconSvg(SAGE));
out("site/assets/favicon.svg", faviconSvg(SAGE));
out("site/assets/icon.svg", logoSvg(SAGE, LOGO_INK.light));

// App icon: 1024 PNG with the mark on a sage tile, and the desktop version with the margin macOS expects around its icons
out("brand/app-icon-1024.png", await png(appIconSvg(SAGE), 1024));
const inner = appIconSvg(SAGE).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
out("desktop/build/icon.png", await png(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><g transform="translate(100 100) scale(0.8046875)">${inner}</g></svg>`, 1024));

// Touch icon (square, the phone rounds it) and the .ico (PNG frames at 16, 32, 48)
out("web/public/apple-touch-icon.png", await png(appIconSvg(SAGE, 0), 180, false));
const frames = [];
for (const size of [16, 32, 48]) frames.push({ size, data: await png(appIconSvg(SAGE, 230), size) });
const header = Buffer.alloc(6 + 16 * frames.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
frames.forEach((f, i) => {
  const at = 6 + 16 * i;
  header.writeUInt8(f.size, at);
  header.writeUInt8(f.size, at + 1);
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(f.data.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += f.data.length;
});
out("web/public/favicon.ico", Buffer.concat([header, ...frames.map((f) => f.data)]));

// Logo with the name, light and dark (Geist from Google Fonts)
for (const [name, bg, ink] of [["light", "#f1f1e8", LOGO_INK.light], ["dark", "#262925", LOGO_INK.dark]]) {
  await page.setViewportSize({ width: 1200, height: 400 });
  await page.setContent(
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@600&display=swap">` +
      `<style>html,body{margin:0}body{width:1200px;height:400px;background:${bg};display:flex;align-items:center;justify-content:center;gap:36px;font:600 190px Geist,system-ui,sans-serif;letter-spacing:-0.045em;color:${ink}}svg{width:200px;height:200px}</style>` +
      `${logoSvg(SAGE, ink)}<span>nido</span>`,
    { waitUntil: "networkidle" },
  );
  await page.evaluate(() => document.fonts.ready);
  out(`brand/logo-lockup-${name}.png`, await page.screenshot());
}
await browser.close();
console.log("Logo files written.");
