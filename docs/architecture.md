# Architecture: one small server, two thin clients (TypeScript)

Status: chat part built (2026-10-14). Shared files are next.

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

## Shared files (next)

Same model as Zed's collaboration (studied, not copied): the host's app owns the files; the server keeps rooms and
peers and forwards messages; it never stores the files.

- **CRDT:** Yjs documents, one per open file. Server: Hocuspocus (Yjs websocket server) with an auth hook that
  checks the Supabase token and chat membership.
- **Desktop host:** the Electron main process reads/watches the shared folder (only the folder the user picked),
  answers file-tree and open-file requests, and writes merged edits back to disk.
- **Guests (web or desktop):** open files through the relay and edit live; cursors via Yjs awareness.
- **AI:** runs on the server and reads/edits host files through the same relay, so its changes are just more edits.
- If the host goes offline, the shared files go offline too.

## Decisions

- TypeScript everywhere: one language and one CRDT library (Yjs) across server, web and desktop.
- Electron over Tauri: Tauri's backend is Rust; Electron keeps the stack all TypeScript.
- Supabase stays for auth, data and chat realtime. The server uses the service role only after checking membership.
- Earlier attempts (Rust + GPUI desktop, client-side AI runs) are in git history.
