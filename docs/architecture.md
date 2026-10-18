# Architecture: one small server, two thin clients (TypeScript)

Status: chat part built (2026-10-14). Shared folder v1 (read only) built 2026-10-18.

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

Later: AI edits with host approval (opencode's edit + diff, Odysseus's sealed approvals), compaction, live co-editing
(Yjs, Zed's model).

## Decisions

- TypeScript everywhere: one language and one CRDT library (Yjs) across server, web and desktop.
- Electron over Tauri: Tauri's backend is Rust; Electron keeps the stack all TypeScript.
- Supabase stays for auth, data and chat realtime. The server uses the service role only after checking membership.
- Earlier attempts (Rust + GPUI desktop, client-side AI runs) are in git history.
