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

One folder per project, linked by the project's host in the desktop app. Nothing is uploaded: the host's app serves
the folder through the server, which relays requests and checks permissions but stores no file contents.

- **Host app (desktop main process):** the folder is picked in a native dialog; its path stays on the host's computer
  (`userData/shared-folders.json`, mode 0600). The main process keeps one outgoing WebSocket per linked project to
  `/api/folder-host` and answers `list`, `read` and `search`. The page can only ask for status, open the dialog and
  unlink: it never sees a path or reads a file. Rules in `desktop/src/folder-fs.ts`: relative paths only, no `..`,
  symlinks never followed, secrets and junk hidden (`.env*`, keys, `.git`, `node_modules`, build folders), binary and
  >2 MB files refused, known token formats masked, literal search only, every answer size-capped.
- **Server:** `folder-relay.ts` accepts only the project host (Supabase token checked on connect and on each refresh,
  host role re-checked every 5 minutes, closed when the sign-in is older than 75 minutes), refuses browser-originated
  sockets (any `Origin` header), validates and size-limits every answer. `routes/folder.ts`: the host links/unlinks;
  every project member can list/read/search (rate limited).
- **Database:** `project_folders` (name, linked by, online flag). Members read it through RLS (it drives the live
  online/offline badge); only `app_folder_*` functions (service role) write it. The path is never stored.
- **AI:** in project chats with a shared folder, runs get `list_files`, `read_file` and `search_files`
  (`folder-tools.ts`). Results are fenced as untrusted data and the instructions forbid following them. Host offline:
  the tool says so and the AI tells the chat. ChatGPT plan connections accept no tools, so they can't read the folder.
- **UI:** a folder row under the project name (left panel) and a chip in the chat header open one dialog: status,
  read-only browser, and share/change/stop for the host in the desktop app. The web app shows status and browses.

Later: AI edits with host approval, live co-editing (Yjs, Zed's model), `.gitignore` support.

## Decisions

- TypeScript everywhere: one language and one CRDT library (Yjs) across server, web and desktop.
- Electron over Tauri: Tauri's backend is Rust; Electron keeps the stack all TypeScript.
- Supabase stays for auth, data and chat realtime. The server uses the service role only after checking membership.
- Earlier attempts (Rust + GPUI desktop, client-side AI runs) are in git history.
