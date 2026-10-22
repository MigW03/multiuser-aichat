# Architecture: one small server, two thin clients (TypeScript)

Status: chat part built (2026-10-14). Shared files v1 (read only) built 2026-10-18, per-owner 2026-10-19. AI file edits with host approval built 2026-10-19. Connected tools (MCP, local servers) built 2026-10-19.

## Pieces

```
            ┌────────────── Supabase ──────────────┐
            │ Auth · Postgres (RLS) · Realtime      │
            └───────▲───────────────▲──────────────┘
                    │ reads,         │ service role
                    │ chat realtime  │
 ┌─────────────┐    │        ┌───────┴────────────────────────┐
 │ Desktop     │────┼───────▶│ Server (Node, Hono)             │
 │ Electron    │ HTTPS (+WS) │ - send message, AI runs         │
 │ hosts files │◀───────────▶│ - API keys (encrypted, write-   │
 └─────────────┘             │   only)                         │
 ┌─────────────┐             │ - next: collab relay (Yjs)      │
 │ Web (Vite)  │────────────▶│ local now, Fly.io later         │
 └─────────────┘             └─────────────────────────────────┘
```

Web and desktop render the same React app (`ui/`). The desktop app is Electron around the web build, plus (next)
the local file host.

| Concern | Lives in | Why |
|---|---|---|
| Accounts, chats, members, messages | Supabase | RLS protects reads; clients read directly |
| Chat realtime | Supabase Realtime (`chat:<id>`) | Postgres changes + broadcast stream snapshots |
| Sending + AI runs | Server | AI output is shared, so it must come from a trusted place; runs survive a client quitting |
| API keys | Server, AES-256-GCM, write-only | Never on devices; one place to secure |
| Shared files | Host's computer | Files never leave the host's machine except as live edits |
| File sharing relay | Server | Routes edits, checks who may join, lets the AI read/edit host files |

## Projects, chats, people (built 2026-10-18)

- A **project** has up to 10 people (pending invites count) with roles Host, Admin and Member, and many chats that
  everyone in it can see. **Your chats** on the home screen are private to you and the AI until you invite someone.
- **Access:** clients read through RLS only (`projects`, `project_members`, `chats`, `messages`, ...). Every write goes
  to the server, which calls an `app_*` SQL function (service role only) with the acting user's id; the function checks
  the role and raises a short code the server turns into a message. `supabase/tests/` runs the migrations on a
  throwaway Postgres and checks RLS, roles, invites, caps and which functions each role may call.
- **Invites** are one email each, 7 days, locked to the invited address (the account must have confirmed it).
- **Realtime:** `chat:<id>` carries message changes, stream snapshots, typing hints and presence; `project:<id>`
  carries presence for the green dots. Broadcasts and presence are hints only; nothing is decided from them.

## Shared files (read only; per-owner since 2026-10-19)

People share folders and files from their own computers in the desktop app, up to 20 items per project in all.
Nothing is uploaded: each owner's app serves its items through the server, which relays requests and checks
permissions but stores no file contents. The project sees one top level made of the items' names (`my-app/src/index.ts`,
`notes.md`), whoever shares what; every path starts with an item's name.

- **Who shares:** the host and admins share directly. A member's pick is a request that waits ("pending") until the host
  or an admin approves it (Approve / Decline card at the top of the Files panel); nothing of a pending item is readable.
  The owner, the host and admins can remove an item. Leaving a project removes what you shared in it.
- **Owner's app (desktop main process):** items are picked in a native dialog or dragged onto the Files card; their
  paths stay on the owner's computer (`userData/shared-folders.json`, mode 0600, each item with a random key). The main
  process keeps one outgoing WebSocket per project to `/api/folder-host`. Its `hello` reports the items (key, suggested
  name, kind: never a path); the server answers with the name the project gave each and whether it is approved, and the
  app serves **only approved items under those names**. It answers `list`, `read`, `glob`, `grep` and the proposal
  requests (`folder-items.ts`, `folder-fs.ts`). The page can only ask for status, open the dialog, hear what was dropped
  (names only; paths wait in the app until the page confirms), remove an item and stop sharing: it never sees a path or
  reads a file. A drop is read from the OS by the preload script (`webUtils.getPathForFile`, trusted events only).
  Rules: relative paths only, no `..`, symlinks never followed, secrets and junk hidden (`.env*`, keys, `.git`,
  `node_modules`, build folders), binary and >2 MB files refused, known token formats masked, every answer size-capped.
  Glob and grep skip `.gitignore`d and hidden files; grep runs in a worker thread stopped after 10 s.
- **Server:** `folder-relay.ts` accepts any project member's app, one connection per owner and project (Supabase token
  checked on connect and on each refresh, membership re-checked every 5 minutes, closed when the sign-in is older than
  75 minutes), refuses browser-originated sockets, validates and size-limits every answer, and has the database record
  the items (`app_share_sync`). `folder-hub.ts` routes each request by the first path segment to the owner of that
  **approved** item (the database's list, cached a few seconds), builds the top level itself, fans a search with no path
  out to every online owner and cuts each owner's results to their own approved items, and refuses a path-less git or
  command request when more than one folder is shared. `routes/folder.ts`: approve/decline a request, remove an item;
  every project member can list and read (rate limited).
- **Database (0015):** `project_share_hosts` (project, owner, online) and `project_shares` (owner, app key, name unique
  in the project, kind, status pending/active). Members read them through RLS (pending rows only the owner, the host and
  admins see); only `app_share_*` functions (service role) write. Paths are never stored.
- **AI:** in project chats with shared files, runs get opencode's `read` (files and folders, `<line>: <content>`,
  offset/limit, 2000 lines), `glob` and `grep` (regex or literal, include, 100 results) with opencode's output shape
  (`folder-tools.ts`). Results are fenced as untrusted data and the instructions forbid following them. An owner
  offline: the tool says so and the AI tells the chat. ChatGPT plan connections get the tools too; if a model or
  connection refuses tools, the answer is retried once without them and says it can't open the files.
- **UI:** the right column of a project's chats (a 320 px column, the Files card on top, Notes under it later), shown and
  hidden from the chat header. Each row has a presence dot on its icon (its owner's app is online or not; a hover that
  rests 600 ms explains it) and a three-dot Remove menu; requests wait as cards for the host and admins. In the desktop
  app: Share menu (folder or files) and drag and drop. The web app shows and browses but cannot share (no real paths).
- **Known limit:** if an owner's app is offline when the host or an admin removes one of their items, the app reports it
  again when it next connects (as a new request for a member, or approved at once for an admin or the host).

## AI file edits (built 2026-10-19; git below; commands are the next phase)

Follows opencode's `edit` and `write` tools (names, inputs, tolerant matching) with one forced difference: opencode asks
the person at the terminal, but here several people share a chat and the files sit on the host's computer. So a change
is only a **proposal**, and the host's desktop app is the only thing that can write it.

- **Off by default.** The host switches "Let the AI propose file changes" on in Project settings (project menu > Project settings, a page that replaces the chat area; more settings go there later). The choice
  lives on the host's computer (same file as the folder link) and is reported to the server on connect. No database
  change. Only then do project chats get `edit` and `write`.
- **Flow.** AI calls `edit` (read-first rule, as in opencode) -> server relay request (`edit` / `write`, long timeout) ->
  host app reads the file, applies the match (`edit-match.ts`: exact, line-trimmed, block-anchor, whitespace, indentation,
  escapes, boundary), builds a unified diff and writes nothing -> a preview frame goes back, the server broadcasts it on
  the chat channel (`approval`) so every member sees the diff on the answer -> the host sees it in the approval dock
  (fed by the app itself over IPC, not by the server) and clicks Approve or Decline -> approving re-checks the file and
  writes it -> the answer (`applied`, `denied`, `expired`, `stale`...) goes back to the AI as the tool result.
- **Sealed approval** (idea from Odysseus, no code taken): what is approved is the file as the diff was made. The app
  keeps path, inode and SHA-256; if the file changed, was replaced or became a link before the click, nothing is
  written and the AI is told to read it again. The write is temp file + rename, keeping mode, line endings and BOM.
- **Blocked paths stay blocked.** Same rules as reads (no `..`, no symlinks, nothing hidden: `.env`, keys, `.git`,
  `node_modules`, build folders), plus: no device names, no trailing dots or spaces, a file that holds a secret-shaped
  string cannot be edited (the mask would be written into it), and new text that looks like a secret is refused.
- **Limits.** 3 open proposals per project, 30 per 10 minutes, 5 minutes to decide, cancelled by Stop / app quit /
  disconnect / unlinking. Edit text 200k chars, new file 500k chars, files up to 2 MB, plain UTF-8 only. A run that may
  propose changes gets a 20 minute lock and 25 steps instead of 5 minutes and 10.
- **Visible.** The answer shows "Changed src/a.ts" (kept in the answer's meta, within its 1 KB jsonb check) next to
  "Read N files". Cards for files that run code (CI config, `package.json`, shell scripts) carry an extra warning.

## Git (built 2026-10-19)

A second host switch, "Let the AI use git" (Project settings), also off by default and stored on the host's computer.
It covers the shared folder when it is a git repository (one shared folder, or `path` names which of several).

- **Reads, no prompt:** `git_status`, `git_diff` (worktree, staged or head), `git_log`, `git_show`, and for members a
  Changes list in the folder card (`GET /folder/git/status|diff`, same membership check as file reads). The AI never
  writes a command: `desktop/src/folder-git.ts` builds every argument list from checked values and runs git directly
  by its full path, with hooks, fsmonitor, pagers, external diff, textconv, signing and credential helpers forced off,
  the user's and system git config not read, a minimal environment, a 10 s limit and a size cap. A repository whose own
  config defines filters, diff/merge drivers, includes or a different work tree is refused (`git_unsafe`) because those
  run programs and cannot be switched off from outside. Nothing hidden is shown (`.env`, keys, `.git`, `node_modules`,
  build output): status entries and whole file sections of a diff are dropped (a header git had to quote is dropped
  too); output passes the secret masking; `show` takes commits only (never a blob, which would print any file);
  git's own error text never leaves the host's computer.
- **Writes, always asked:** `git_add`, `git_commit`, `git_restore`, `git_branch` (a new branch, `switch -c`) are
  proposals like edits: the host sees the exact command and what it changes (files to add; message and staged diff for
  a commit; the diff that would be lost for a restore, flagged as destructive) and clicks Approve in the app. Sealed to
  the state the host saw (the status, or HEAD plus the index, or the diff): a changed repository is refused. Add leaves
  out hidden files, ignored files and symlinks; commit refuses when something staged is outside the shared folder or is
  a hidden kind; hooks are off and `--no-verify`/`--no-gpg-sign` are set; the commit uses the host's own git identity.
- **Not possible for the AI:** push, pull, fetch, checkout of other branches, reset, amend, delete, any other command.

## Commands (built 2026-10-19)

A third host switch, "Let the AI propose commands" (Project settings), off by default, stored on the host's computer.
Turning it on is confirmed in a window the app itself shows (the page cannot click it). The AI gets one tool, `bash`
(command, description, workdir, timeoutSec: opencode's shape), and **every command asks, every time**: no "always
allow", no pattern allow-list, no auto mode.

- **Approval:** the proposal appears in the approval dock with the exact command, folder, time limit, what the AI says
  it is for, and warnings from a pattern list (deletes files, network or installs, privileges, secrets or environment,
  runs downloaded code, background jobs: display only, they never approve or block anything). Clicking Approve opens a
  native confirm window (`dialog.showMessageBox` from the main process) that repeats the command; its default button is
  Cancel. Cancelling there leaves the card waiting. A script injected into the page can click Approve but not the native
  window, so it cannot run anything.
- **Running** (`desktop/src/folder-exec.ts`): `/bin/sh -c` (cmd on Windows) in the shared folder or a folder inside it
  (no links, nothing hidden, checked again at run time), no standard input, own process group, a trimmed environment
  (PATH, HOME, USER, SHELL, locale, TMPDIR and a few CI settings; none of the host's tokens or keys), stderr merged in
  order, 120 s default and 600 s at most, then killed together with everything it started. Stop in the chat, the host's
  app disconnecting, quitting, or switching commands off also kills it. One command at a time per project. Output keeps
  the first 30k and last 20k characters, terminal escape sequences and control characters are removed, secret-shaped text is
  masked, and the AI receives it fenced as data.
- **No sandbox.** An approved command runs with the host's own rights and can read or change anything the host can,
  including files outside the shared folder and files the shared folder hides. The approval is the only barrier, which
  is why the command, folder and time limit are fixed when proposed and the host confirms twice. A macOS or Windows
  sandbox is a possible later step.

## Connected tools, MCP (phase 1 built 2026-10-19: local servers over stdio)

Follows opencode's MCP client (config shape, `<server>_<tool>` names, per-tool switches; the official
`@modelcontextprotocol/sdk`) with two chosen differences (Miguel). **No approval per call**: opencode asks before each
tool use; here the person decides once, when they add a server, and after that the AI picks and uses the tools on its own
(code tools keep their approvals). **MCP servers belong to the person, not to a project**: they live in the desktop app's
own Settings (bottom-left account menu > "MCP servers"), run on that person's computer with that person's accounts, and the
chat server only relays.

- **Whose tools:** the AI uses the tools of the person who asked, in any chat (project or private), for that answer only.
  Someone else's question never gets your tools, so nobody borrows another person's logins. `run-queue.ts` asks
  `mcpRelay.tools(authorId)` and calls `mcpRelay.call(authorId, ...)` with the asker's id fixed; a test checks one person's
  call never reaches another's socket. If the asker's desktop app is offline or signed out, no tools are offered and the
  AI answers without them. Needs no shared folder and no database change.
- **Connection:** the desktop app keeps one WebSocket per signed-in user to `/api/mcp-host` (`desktop/src/mcp-conn.ts`,
  `server/src/mcp-relay.ts`): hello with the Supabase token, token refresh, 75 minute sign-in age limit, browser (Origin)
  refusal, ping, one app per person (a newer one replaces the older). The page tells the app who is signed in
  (`useMcpHost`); signing out stops everything.
- **Setup lives on the computer** (`userData/mcp-servers.json`, mode 0600, keyed by user id so two accounts on one
  computer never see each other's servers; environment values encrypted with Electron `safeStorage`, so a server with
  secrets can't be saved without secure storage). Settings > MCP servers: list with status (Starting / Running / Failed
  with the server's own last output, masked), a switch per server, a switch per tool, Remove, Add. The web app shows a
  note: servers are set up in the desktop app.
- **Adding a server** (`mcp-ipc.ts`): the page sends what the person typed; the app splits the command line itself
  (quotes, no shell, no expansion) and shows every part in quotes, the environment variable names and the risk in a
  window the page cannot click. Only "Add and run" starts anything.
- **Running** (`mcp-client.ts`, `mcp-host.ts`): a server runs only while its person is signed in here and its switch is
  on. Started with the SDK's stdio transport, no shell, in an empty folder the app owns, with a trimmed environment (no
  host tokens) plus what the person typed for that server. Killed on switch-off, removal, sign-out and quit.
- **What the server is told:** the app sends the tool list when connected and whenever it changes (`mcp` message);
  `mcp-relay.ts` checks it again (name patterns, 10 servers, 50 tools, 8 KB schemas, descriptions cut to one line of 1000
  characters) and a list that breaks a rule means no tools. Calls go down the same socket; the app checks server, tool,
  switches and argument size again. Limits: 25 calls per answer, 120 per person per 10 minutes, 4 at once, 60 s each,
  results cut to 50k characters.
- **AI** (`server/src/mcp-tools.ts`): tools named `<server>_<tool>` (a built-in tool's name can never be taken over), the
  tool's JSON schema as input, results as plain text (binary left out, control characters and secret-shaped text
  removed) fenced in `<connected_tool_data>` and labelled as data, never instructions. The instructions tell the model to
  use a fitting tool on its own initiative, without asking, only for what the asker asked. The answer shows "Used connected
  tools: server: tool".
- **Risk, in plain words:** without per-call approval the AI acts with that server's rights whenever it judges a tool
  useful. Other people's messages in the same chat could try to steer it into using the asker's tools (prompt injection),
  and a tool result written by a third party can try the same. Mitigations: nothing exists until the person adds a server
  and confirms its exact command, per-server and per-tool switches, small tool lists, fenced results, call limits, tools
  shown under the answer. What a tool returns lands in the chat, so everyone in that chat can read it; Settings and the
  confirm window say so. Keys belong in the environment field: the command itself is stored and shown as typed.
- **Next:** polish (tools list-changed, reconnect button for local servers, resources and prompts, importing a config file).

### Remote MCP servers (second PR, built 2026-10-19)

Tool servers at an https address, called by the chat server for the person who added them, so they work in the web and
desktop apps alike and when the person's computer is off. Same rules as local ones: the AI uses the asker's own servers
only, on its own initiative, with no per-call approval; results are fenced as data. Settings > MCP servers shows two
sections: Remote servers (everywhere) and On this computer (desktop).

- **Storage** (migration 0014, `user_mcp_servers`): like `user_api_keys`, RLS on with no policies and no client grants, so
  only the server reads or writes it. A header value and the OAuth blob (client registration, tokens, PKCE verifier) are
  encrypted with the same AES-256-GCM key as AI keys and write-only: the page gets name, address, status, tool list and the
  last 4 characters of a header value. At most 10 per person (a trigger with an advisory lock, so races can't exceed it),
  names unique per person, https only.
- **Connecting** (`mcp-remote.ts`): the MCP SDK client, Streamable HTTP with a fallback to the older SSE transport, 15 s to
  connect, 60 s per call, one connection per server kept 5 minutes after the last use, tool lists and results cleaned
  like local ones (`shared/mcp-text.ts`). Failures show one fixed sentence (could not reach, blocked address, token
  rejected, sign in needed, not an MCP server); the server's own error text only goes to our log.
- **What the server refuses** (`ssrf.ts`): not https, credentials in the address, localhost and local-looking names, and any
  address that resolves to a private, loopback, link-local (cloud metadata), carrier-grade NAT, documentation, multicast or
  reserved range, IPv4 and IPv6 (mapped, NAT64, 6to4, Teredo included). The name is resolved by our own lookup at every
  new connection and the connection is refused if ANY answer is blocked, so a name that turns private after being added
  (DNS rebinding) is caught too. Only redirects within the same origin are followed (the SDK's default), responses are
  capped at 8 MB, and all OAuth discovery and token traffic goes through the same guarded fetch.
- **Header sign-in:** one header (name and value) sent with every request; reserved headers (Host, Content-Type, Cookie,
  the MCP session headers and others) and line breaks are refused.
- **OAuth** (`mcp-oauth.ts`, opencode's flow done by the server so it is the same on web and desktop): discovery, dynamic
  client registration, PKCE. Sign in returns the provider's page, which opens in a new tab (the desktop app hands https
  pages to the system browser). The provider redirects to `GET /api/mcp/oauth/callback` on this server, which has no bearer
  token, so the proof is a random single-use state tied to one row and valid 10 minutes; a reused, expired, unknown or
  malformed state gets a plain page that repeats nothing from the request. Needs `SERVER_URL` (this server's public
  address); without it OAuth is off and the Add dialog says so. Sign out and Remove delete the tokens.
- **Run:** `run-queue.ts` asks `remoteMcp.state(asker)` (waits up to 8 s for connections that are starting) next to the
  local tools; tool names stay `<server>_<tool>` and never replace a built-in or an earlier tool.
- **Risk, in plain words:** our server holds the person's tokens, encrypted. A breach of the server (or of
  `KEY_ENCRYPTION_SECRET`) would expose them, which local servers avoid by keeping secrets only on the person's computer.
  A remote server sees everything the AI sends it. Prompt injection and chat visibility are as for local servers.

Later: compaction, live co-editing (Yjs, Zed's model).

## Preview of a localhost page (built 2026-10-21, desktop app only)

A person developing a web project on their own computer can show it in the main panel, beside the chat or filling the panel. Entry points: the Preview button in the chat header, a localhost address written out in an AI answer (link or button under it), and the address box of the empty state, which lists dev servers found running.

- **Engine:** an Electron `WebContentsView` owned by the main process (`desktop/src/preview.ts`), laid over a placeholder box the page reserves (`ui/src/components/PreviewPanel.tsx` sends its rectangle). Not an iframe: a frame gets third-party cookies, is stopped by `X-Frame-Options`, and gives no load-failed event. Not the `<webview>` tag: Electron advises against it and the app switches it off.
- **Wall:** its own process with no preload (no `window.desktop`), `sandbox`, no node, its own cookie jar (`persist:preview` session), permissions and downloads refused, popups denied. The app's CSP is unchanged.
- **Addresses:** `parsePreviewUrl` (`shared/src/preview-url.ts`) accepts only http(s) to `localhost`, `127.0.0.1` or `[::1]`, any port, no user name. The page checks, the main process checks again on open, on navigation and on redirects; an https address outside localhost goes to the person's browser.
- **Floating view:** it sits above the page's own layers, so the panel hides it (and leaves a JPEG picture of it) while a dialog, menu or notice reaches its rectangle, and follows layout changes frame by frame.
- **Server not running:** `did-fail-load` with `ERR_CONNECTION_REFUSED` shows "Nothing is running at ..." and retries every 3 seconds.
- **Web:** none. The server cannot reach a person's localhost, and a page on https may or may not frame it depending on the browser, with no way to see whether it is running. In a browser the button and chips do not show.
- Nothing about a preview is shared: other members never see it, nothing is uploaded or stored on the server. The last address per project and the panel width stay in the device's local storage.

## Shared files in the main panel (dev branch, 2026-10-22)

A shared file opens in the middle of the main panel, **in place of the chat** (the chat stays mounted behind it, so typed text and scroll are kept). Three columns as always: left panel, file, Files column. Desktop and web: it only needs the existing relay read (`GET /api/projects/:id/folder/read`), nothing new on the server.

- **Entry points:** a file in the Files card (`FolderBrowser`), a file path written as `code` in an answer or in a Markdown file (`FileCode` in `Markdown.tsx`), and a button under an answer for the files it names (`FileChips` in `Messages.tsx`, three, then "+N more"). A path from an answer is only a guess (shared paths start with the shared folder's name), so `candidatePaths` tries it as written and then under each shared folder; if none has it the panel says so. Text counts as a path only with a readable extension and not for names like `Next.js` (`ui/src/lib/fileKind.ts`).
- **Panel:** `ui/src/components/FilePanel.tsx`, state in `Shell` (`fileReq`, `AppContext.files`). Back to chat, close, Esc, reload, copy. The localhost preview and a file never show together: opening one closes the other. Switching chats in the same project keeps the file; leaving the project or opening project settings closes it.
- **Markdown:** Preview (default) / Source. Preview uses the chat's renderer: raw HTML is shown as text, only http(s)/mailto links, no images. A relative link to another file (`resolveRelative`, cannot climb above the shared folder) opens that file; it is a button, never an `href`.
- **HTML:** Preview (default) / Source. The Preview is **static and never runs the file's code**. Three walls (`ui/src/lib/htmlFrame.ts`): (1) DOMPurify cleans the text (scripts, forms, frames, `<meta>`, `<link>`, `<base>`, event attributes, link targets, non-`data:` picture sources go); (2) a Content-Security-Policy `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:` is the first thing in the page; (3) the iframe has an empty `sandbox` (no scripts, no same origin, no forms, no popups, no top navigation) and `referrerPolicy="no-referrer"`. The file's own `<style>` and inline `data:` pictures work; files next to it (style.css, logo.png) are not loaded. Never add `allow-scripts` or `allow-same-origin` to the frame. Needs a change of this document and a security review first.
- **Limits:** one read returns at most 2000 lines / 50 KB (`FOLDER_LIMITS`), so a longer file is cut and the panel says which lines it shows (the HTML Preview then shows only that part). Binary, over 2 MB, blocked paths: the host's refusal is shown as written.
- Own view only: other members never see what a person has open; nothing is stored.

## Decisions

- TypeScript everywhere: one language and one CRDT library (Yjs) across server, web and desktop.
- Electron over Tauri: Tauri's backend is Rust; Electron keeps the stack all TypeScript.
- Supabase stays for auth, data and chat realtime. The server uses the service role only after checking membership.
- Earlier attempts (Rust + GPUI desktop, client-side AI runs) are in git history.
