# Security notes for audits

A register of the places where the app shows or runs content it does not trust, with the walls around each, what is left over, and what to check again. Written on `dev` (2026-10-22) at Miguel's request so a later audit starts here. Add a section whenever a new surface like these is built, and change the section when its walls change.

"Untrusted" here means: written by a teammate, by the AI, or downloaded into a shared folder. The person looking at it did not write it and may not have read it.

---

## 1. Static preview of an HTML file (file panel, everyone, desktop and web)

- **Where:** `ui/src/lib/htmlFrame.ts`, `ui/src/components/FilePanel.tsx`.
- **What it is:** the text of a shared `.html` file (read through the server relay) shown in an `<iframe srcdoc>` inside the app's own page.
- **Walls (all three, each enough alone against script execution):**
  1. DOMPurify cleans the text first. Removed: scripts, forms, frames, `<meta>` (refresh), `<link>`, `<base>`, `<object>`/`<embed>`, media, event attributes, link targets (`href` on anchors), non-`data:` picture sources.
  2. A Content-Security-Policy in the page itself: `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'`. It comes first in the document.
  3. The frame has an **empty `sandbox`** attribute (no scripts, no same origin, no forms, no popups, no top navigation) and `referrerPolicy="no-referrer"`.
- **Tests:** `ui/src/lib/htmlFrame.test.ts` (jsdom, one case per removal), plus a hostile sample run in Chromium and under the desktop app's own CSP (srcdoc frames inherit the parent's policy).
- **Left over:** a hostile page can still draw a fake login form as pictures and text (nothing is submitted: no forms, no scripts). Large inline CSS can slow the frame. A file longer than one read (2000 lines / 50 KB) is cut.
- **Never:** add `allow-scripts` or `allow-same-origin` to `FRAME_SANDBOX`. Both together let the page remove its own sandbox.
- **Re-audit when:** DOMPurify is upgraded (re-run the tests), the app's CSP changes, or anyone proposes scripts in this frame (use section 3 instead).

## 2. Markdown file and answers (file panel, chat)

- **Where:** `ui/src/components/Markdown.tsx`.
- **Walls:** `react-markdown` without `rehype-raw` (raw HTML is shown as text), only `http(s)`, `mailto` and `#` links, no images loaded (shown as links), links open in the system browser with `noopener`. In the file panel a relative link to another file is a **button**, never an `href` (`resolveRelative` in `ui/src/lib/fileKind.ts` keeps it inside the shared folder). A path written as `code` opens a file only through the same read route as the Files card.
- **Left over:** none known beyond the usual "a link's text can differ from its address" (addresses of AI links are shown under the message).

## 3. Run page: an HTML file running with its scripts (desktop app, the person who shares the file)

- **Where:** `desktop/src/run-server.ts` (file server), `desktop/src/preview.ts` ("run" mode), `desktop/src/folder-ipc.ts` (`folder:run-page`), `ui/src/components/FilePanel.tsx` and `Shell.tsx` (button, preview beside the chat). Tests: `desktop/src/run-server.test.ts` (16).
- **What it is:** the app serves what the person shares from their own disk on `127.0.0.1` and opens the page in the preview's browser view. Scripts, CSS and pictures next to the file work. The page can come from a teammate or the AI, so it is treated as hostile.
- **Walls:**
  1. **Confirmation** in a native window of the main process (default Cancel; once per file until the app quits; forgotten when the folder is unshared). Only the person who shares the file can ask: the app checks the file is an `.html` file inside an item shared from this computer.
  2. **File server** (`createRunServer`): loopback only, random port, started on the first run and stopped 10 s after the last running page closes or when the app quits. Every address starts with a random 192-bit **token**; the `Host` header must be exactly the server's own address (DNS rebinding); GET and HEAD only. Paths go through the same walk as every other read of a shared folder (`locate`: inside an approved item, no `..`, **no symlinks**, secrets/keys/`.git`/build output hidden, same file checked again after opening). Max 25 MB per file. Error texts say nothing about the computer's paths.
  3. **Content-Security-Policy on every answer:** `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; worker-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'`, plus `nosniff`, `no-store`, `no-referrer`, `CORP same-origin`, `X-Frame-Options: DENY`.
  4. **Strict view ("run" mode of the preview):** a session of its own that keeps nothing (in-memory partition `runpage`); no preload, so no bridge to the app; sandbox on, no node; permissions, downloads and popups refused. **No network:** every request to anything but the run server (or `data:`/`blob:`) is cancelled in the app (`webRequest.onBeforeRequest`), a dead proxy (`127.0.0.1:9`, bypass `127.0.0.1` only) catches the rest, and WebRTC cannot send UDP (`disable_non_proxied_udp`). A page that navigates away goes nowhere, and nothing is handed to the person's browser (the "open in my browser" hand-off of the localhost preview is off in this mode, because the address carries the token).
- **Verified in a real Electron window (2026-10-22, Xvfb):** a hostile page ran its script and, in run mode, reached **nothing**: `fetch` and XHR to another host, an image, a script tag, a WebSocket, `window.open`, a navigation and a WebRTC STUN request all produced **zero** hits at a canary server (HTTP and UDP), while the same page in the ordinary localhost mode hit all of them (so the check can see leaks). In run mode `window.desktop` was undefined, `../../../x`, `.env` and a request without the token gave 404, and its own files loaded.
- **Left over (accepted, state them to the auditor):**
  - The running page can read **every file the person shares in that project** through its own server (`connect-src 'self'`). It cannot send it anywhere. A page can still *show* it to whoever looks at the screen.
  - It can burn CPU or memory (own process: the app stays usable; closing the panel kills it).
  - `'unsafe-inline'` scripts are needed for ordinary pages. `eval` is off (no `'unsafe-eval'`), so some bundled libraries will not run.
  - The token is in the address inside the view (history, `document.URL` of the page itself). It is useless outside the running server and `Host`-checked, and goes to nobody (`no-referrer`).
  - Approval is per file path, not per content: if the file changes after the person said yes, the new content runs. A teammate cannot write the person's disk; the AI can only through an edit the person approved.
  - Other programs on the same computer that learn the token could read the shared files while a page runs. They would need the token, which never leaves the app.
  - The `localhost` mode of the preview (the person's own dev server, section 4) is **not** walled like this.
- **Never:** allow `connect-src`/`script-src` to a remote host, give the run view a preload or the app's session, serve anything outside approved items, accept a request without the token, or remove the session-level network block "because the CSP already covers it" (it does not cover navigation or WebRTC).
- **Re-audit when:** Electron is upgraded (re-run the canary check: `scratchpad` harness in the PR thread, rebuilt from `preview.ts` + `run-server.ts`), the preview module changes, the CSP changes, or "allow CDN libraries" is ever requested (that makes it possible for a page to send out what it reads: ask for a new decision first).

## 4. Localhost preview (existing, desktop app)

- **Where:** `desktop/src/preview.ts` (mode `localhost`), `shared/src/preview-url.ts`.
- A browser view of the person's **own** dev server. Own process and cookie jar, no preload, localhost addresses only, popups/downloads/permissions refused. Unlike section 3, the page **can** reach the internet and other localhost ports (a dev project needs CDNs, APIs, HMR). A posted localhost link makes a GET to that port on click. Nobody but the person chooses what runs here: do not route files from teammates through this mode (that is what "run" mode is for: `opts.run.owns(url)` decides the mode in the main process, the page cannot choose).

## 5. Design files and the design canvas (desktop and web, every member)

- **Where:** `shared/src/design.ts` (`designUnsafe`, marker), `desktop/src/folder-design.ts` (host save), `server/src/routes/folder.ts` (design routes), `server/src/folder-tools.ts` (`designTools`), `server/src/design-events.ts`, `ui/src/lib/designModel.ts` (`parseDesign`, `cleanStyle`, `styleSet`), `ui/src/components/design/` (canvas). Tests: `desktop/src/folder-design.test.ts`, `server/src/design.test.ts`, the "design" blocks in `folder-hub.test.ts` and `folder-tools.test.ts`, `ui/src/lib/designModel.test.ts`.
- **What it is:** `*.design.html` files in the shared folder, written by any member from the canvas and by the AI, **without an approval card** (Miguel's decision, 2026-10-23). They are drawn inside the app for everyone in the project, and a person may also open one in a browser outside the app.
- **Walls:**
  1. **Only design files.** The relay ops accept only paths ending in `.design.html`, through the same path walk as every write (inside an approved item, no `..`, no symlinks, nothing hidden, no secrets). The AI's `write`/`edit` on a design file is routed to the design ops (same checks, no card); the approval flow is unchanged for every other file.
  2. **Inert on disk** (`designUnsafe`, checked by the host app on every save, so a forged request to the server cannot skip it): no `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, `<style>`, `<link>`, `<meta>`, `<base>`, SVG `use`/`foreignObject`/animation; no `on*` attribute; no `srcset`, `action`, `formaction`, `ping`, `background`, `poster`, `xlink:href`, `srcdoc`; no `javascript:`/`vbscript:`/`data:text/html` in any attribute (after decoding character references and removing control characters); `src` only as a `data:image/...` picture; in `style` no backslash escapes, `expression()`, `behavior`, `-moz-binding`, `@import`, or `url()` other than an inline picture. A quote-aware tokenizer reads tags, so `>` inside a quoted value cannot hide an attribute. Plain text that mentions these (`JavaScript: the good parts`, `&lt;script&gt;`) is allowed. Max size `DESIGN_LIMITS.chars`; secrets refused as for any write.
  3. **Clean again before drawing** (`parseDesign`): its own DOMPurify instance with the forbidden tags and attributes above, `src` only `data:` pictures, `href` only on `<a>` and only `#`, `http(s)`, `mailto`, and `cleanStyle` on every style. Parsed in a detached, inert document; the canvas draws a copy into a **shadow root** inside an `overflow: hidden` viewport whose content sits under a CSS transform (so `position: fixed` stays inside the canvas). Clicks and middle-clicks on the canvas never follow a link. What cleaning removed is shown in a banner.
  4. **No lost work:** each save names the version it was made from (`baseSha`); a changed file is refused as `stale` and the canvas reloads. The AI replaces an existing file only after reading it in the same run. Undo is local (whole text, 100 steps).
  5. **Chat marker:** `designMarker` escapes every value, and `parseDesignMarker` reads one marker only at the very start of a message, so typed text cannot forge a second marker or break out of a value. The marker only selects what the AI looks at; it grants nothing.
- **Left over (accepted, state them to the auditor):**
  - Any member can create, change or empty any `.design.html` file inside the shared items, on the host's disk, without the host saying yes each time (rate limit 120 saves a minute per person). Other files are untouched.
  - The AI can do the same through a prompt injection (for example a pasted page that says "rewrite the design"). Worst case is a spoiled design file; undo and git history help. It cannot write anything else without the usual approval.
  - A hostile design can still **show** anything as text and pictures (a fake dialog drawn on the canvas). It cannot run code, submit forms or load from the network.
  - `<a href="https://...">` is kept in the file (designs show links) but never followed on the canvas.
  - The realtime hints (`design_saved`, `design_ai`, `design_ask`, `design_handover`, presence) travel on the project channel, which every member can also send on. A member could fake them: make others reload, show the canvas as read-only for up to 120 s, or claim the editor seat. These are courtesy locks; nothing is saved because of them, and `baseSha` still protects every save.
  - Opening a design outside the app (a browser) shows inert HTML; nothing more is checked there.
- **Never:** let `design_write`/`design_edit` accept a path that is not `.design.html`; drop the host-side `designUnsafe` check "because the canvas cleans anyway" (the file can be opened elsewhere and the AI reads it); draw a design outside the shadow root or without `parseDesign`; or add `<style>` support without a new review (selectors could restyle the app if the shadow root is ever removed).
- **Re-audit when:** DOMPurify is upgraded, the design format gains new tags or attributes, designs become editable by people outside the project, or the canvas starts running anything (prototype mode, scripts).

---

## 6. Stored copy of shared files (Cloudflare R2, server, every member)

- **Whose content:** the files of an approved shared item, uploaded by that item's owner. Every project member can list and download them.
- **The wall:** every route checks the signed-in person belongs to the project and that the item is approved (`activeShareFor`); only the item's owner writes or removes. Keys are `projects/<project uuid>/<item uuid>/<path>` built only by `file-paths.ts` from UUID-checked ids and a validated path (no `..`, `.`, empty parts, backslash, `:`, control or direction characters, Windows device names, hidden names such as `.env`, `.git`, `node_modules`, `*.pem`).
- **What the content can do:** nothing on our origin. Objects are stored as `application/octet-stream` with `Content-Disposition: attachment`, and the download address (valid 60 s, `no-store`) forces both again, so a stored HTML file is saved, not run, and R2 is a different origin from the app.
- **Secrets:** text files that contain a key or token are refused (422, `file-scan.ts`, same patterns as `redactSecrets`), because a download would otherwise skip the masking that reads of a shared folder get. Binary files are not scanned.
- **Limits:** 25 MB a file, 1 GB and 20,000 files a project, 3 uploads in memory at once, `Content-Length` required, rate limits per person.
- **Kept afterwards:** the object, until the owner removes it, the item stops being shared, or the project is deleted (best effort; an orphan can't be read because reads need an approved item).
- **Never:** build a key from anything but `file-paths.ts`; serve an object through our own origin with its stored type; return the R2 credentials, endpoint or bucket in an answer or a log line; let a non-owner write.
- **Re-audit when:** the AI reads stored files, the desktop app uploads automatically, files are served inline for preview, or items can be renamed (a one-file item is stored under its name).

---

## Questions an audit should ask of every new surface like these

1. Whose content is it, and who decides to look at it or run it? Is there a confirmation the page cannot click?
2. What is the wall (process, sandbox, policy, session), and does it hold when the policy header is ignored?
3. What can the content read (files, cookies, app state) and where can it send it (network, navigation, other windows, WebRTC, the system browser)?
4. What is kept afterwards (storage, cookies, caches, history, tokens in addresses)?
5. Is there a test that fails if the wall is removed?
