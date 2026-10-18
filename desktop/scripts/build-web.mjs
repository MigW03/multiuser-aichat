// Builds the web app for the installed desktop app into desktop/web-dist (web/dist stays the website's build).
// The chat server's address is baked into the bundle, so the installed app talks to the live server, not localhost.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const serverUrl = (process.env.DESKTOP_SERVER_URL || "https://multiuser-chat-server.fly.dev").trim();
if (!/^https:\/\//.test(serverUrl)) {
  console.error(`DESKTOP_SERVER_URL must be an https:// address, got "${serverUrl}".`);
  process.exit(1);
}

// Optional: the website's address, so "Copy link to chat" gives https:// links others can open in a browser.
const webUrl = (process.env.DESKTOP_WEB_URL || "").trim();
if (webUrl && !/^https:\/\//.test(webUrl)) {
  console.error(`DESKTOP_WEB_URL must be an https:// address, got "${webUrl}".`);
  process.exit(1);
}

const result = spawnSync(
  "npm",
  ["run", "build", "-w", "web", "--", "--outDir", resolve(here, "../web-dist"), "--emptyOutDir"],
  { cwd: root, stdio: "inherit", env: { ...process.env, VITE_SERVER_URL: serverUrl, ...(webUrl ? { VITE_WEB_URL: webUrl } : {}) }, shell: process.platform === "win32" },
);
process.exit(result.status ?? 1);
