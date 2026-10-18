# Multiuser Chat

A group chat where everyone shares one AI. Each person brings their own API key and model; the AI sees who said
what and answers in the shared conversation, live for everyone.

Full TypeScript: one small server and two thin clients (web and desktop) that share the same React UI.

```
shared/    types and constants used everywhere
server/    Node (Hono): sends messages, runs the AI, stores API keys encrypted
ui/        React UI shared by web and desktop (theme in ui/src/theme.ts)
web/       Vite app around ui/
desktop/   Electron app around the same build
supabase/  database migrations (auth, chats, messages, realtime, RLS)
docs/      architecture and plans
```

## Run it locally

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill it in. The old `NEXT_PUBLIC_SUPABASE_*` names work too.
3. `npm run dev` starts the server (http://localhost:8787) and the web app (http://localhost:5173). No desktop app.

Each part also runs on its own, from its own folder (the web app needs the server running to chat):

| What | From the repo root | From its folder |
| --- | --- | --- |
| Server only | `npm run dev:server` | `cd server && npm run dev` |
| Web app only | `npm run dev:web` | `cd web && npm run dev` |
| Server + web | `npm run dev` | |
| Desktop (Electron) with server and web | `npm run dev:desktop` | `cd desktop && npm run dev` (server and web must already run) |

The desktop app loads the web dev server, so it always needs the web app running next to it.

For the desktop app from a production build: `npm run build`, then `npm start -w desktop`.

## Supabase setup

Run the migrations in `supabase/migrations` in order (the SQL editor or `supabase db push`). Then, under
Authentication:

- **Providers > Email:** turn on **Confirm email**. Invites are locked to the invited address, and that only means
  something when people have to prove they own it.
- **URL Configuration:** add the web app's address (for example `http://localhost:5173`) to the redirect URL
  allow-list, so the links in confirmation and password reset emails come back to the app.

Migration `0010` makes the chat tables read-only for clients (every change goes through the server) and drops the old
chat invite links and the per-chat model columns. Existing chats become "Your chats".

## How it works

- **Supabase** handles accounts, the database (with row level security) and realtime.
- **Clients** read chats and messages straight from Supabase and subscribe to the private channel `chat:<id>`.
- **Projects** hold shared chats for up to 10 people (pending invites count). Roles are Host, Admin and Member.
  Invites are one email address each, last 7 days and only work for that address. **Your chats** on the home screen
  start private (you and the AI); you can invite people into one, and it becomes a shared chat.
- **Sending** goes to `POST /api/chats/:id/messages` on the server, which checks membership and that the sender has
  a key, saves the message as `pending`, and runs the AI queue (`server/src/run-queue.ts`): one run per chat at a
  time, each answering one person's messages with that person's key and model. The reply streams to everyone as
  broadcast snapshots and is saved when done. A message that tags a person with `@` is not answered by the AI, and
  neither is one from a person without a key. Summaries run in the same queue with the requester's key.
- **API keys** are sent once to `PUT /api/keys/:provider`, checked with the provider, encrypted with AES-256-GCM and
  stored in `user_api_keys`, which only the server can read. Clients only ever see the last 4 characters.
- **ChatGPT plan** (unofficial): instead of a key, a user can sign in to their own ChatGPT subscription with the device
  code flow the Codex CLI uses (`server/src/chatgpt.ts`). The tokens are encrypted the same way and stored in
  `user_chatgpt_auth` (server-only). Refresh tokens rotate, so one server at a time refreshes, claimed with a lease
  row. Requests go to ChatGPT's Codex backend, not the OpenAI API. It is not an official integration for apps like
  this one: it can break at any time and may go against OpenAI's terms, and the sign-in screen says so. Each run
  uses the plan of the person who sent the message, never another member's.

## Security notes

- The server's `SUPABASE_SECRET_KEY` and `KEY_ENCRYPTION_SECRET` never reach a client: Vite only exposes `VITE_*` and
  `NEXT_PUBLIC_*` variables.
- The desktop app runs with context isolation, sandboxing, no Node integration, a strict CSP, and loads its UI from a
  private `app://` origin. Links open in the system browser.
- See `docs/architecture.md` for the design and what is next (shared files between members' computers).
