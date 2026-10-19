# Architecture: one small server, two thin clients (TypeScript)

Status: chat part built (2026-10-14). Shared folder v1 (read only) built 2026-10-18. AI file edits with host approval built 2026-10-19. Connected tools (MCP, local servers) built 2026-10-19.

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

## Shared folder (v1, read only, built 2026-10-18)

The project's host shares up to 20 folders and files from their computer in the desktop app. Nothing is uploaded:
the host's app serves them through the server, which relays requests and checks permissions but stores no file
contents. One folder alone is shared as is (paths like `src/index.ts`); several items appear as a top level of their
names (`my-app/src/index.ts`, `notes.md`).

- **Host app (desktop main process):** items are picked in a native dialog; their paths stay on the host's computer
  (`userData/shared-folders.json`, mode 0600). The main process keeps one outgoing WebSocket per project to
  `/api/folder-host` and answers `list`, `read`, `glob` and `grep` (`folder-items.ts`, `folder-fs.ts`). The page can
  only ask for status, open the dialog, remove an item and stop sharing: it never sees a path or reads a file. Rules:
  relative paths only, no `..`, symlinks never followed, secrets and junk hidden (`.env*`, keys, `.git`,
  `node_modules`, build folders), binary and >2 MB files refused, known token formats masked, every answer
  size-capped. Like opencode (ripgrep), glob and grep skip `.gitignore`d and hidden files; grep runs in a worker
  thread that is stopped after 10 s so a runaway regular expression can't hang the app.
- **Server:** `folder-relay.ts` accepts only the project host (Supabase token checked on connect and on each refresh,
  host role re-checked every 5 minutes, closed when the sign-in is older than 75 minutes), refuses browser-originated
  sockets (any `Origin` header), validates and size-limits every answer. `routes/folder.ts`: the host links/unlinks;
  every project member can list and read (rate limited).
- **Database:** `project_folders` (name, linked by, online flag). Members read it through RLS (it drives the live
  online/offline badge); only `app_folder_*` functions (service role) write it. Paths are never stored.
- **AI:** in project chats with shared files, runs get opencode's `read` (files and folders, `<line>: <content>`,
  offset/limit, 2000 lines), `glob` and `grep` (regex or literal, include, 100 results) with opencode's output shape
  (`folder-tools.ts`). Results are fenced as untrusted data and the instructions forbid following them. Host offline:
  the tool says so and the AI tells the chat. ChatGPT plan connections get the tools too; if a model or connection
  refuses tools, the answer is retried once without them and says it can't open the files.
- **UI:** the right column of a project's chats (the approved hi-fi board: a 320 px column, the shared folder card on
  top, Notes under it later), shown and hidden from the chat header. The card shows status, a read-only browser, and
  for the host in the desktop app: add folders or files, remove one, stop sharing. The web app shows status and browses.

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
- **Next:** remote servers over HTTP with headers (and whether they should run on the chat server so they also work in
  the web app: needs a table and a decision), then OAuth (opencode's flow), then polish (list-changed, reconnect,
  resources and prompts).

Later: compaction, live co-editing (Yjs, Zed's model).

## Decisions

- TypeScript everywhere: one language and one CRDT library (Yjs) across server, web and desktop.
- Electron over Tauri: Tauri's backend is Rust; Electron keeps the stack all TypeScript.
- Supabase stays for auth, data and chat realtime. The server uses the service role only after checking membership.
- Earlier attempts (Rust + GPUI desktop, client-side AI runs) are in git history.
