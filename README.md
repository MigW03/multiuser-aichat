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
3. `npm run dev` starts the server (http://localhost:8787), the web app (http://localhost:5173) and the desktop app.
   `npm run dev:web` skips the desktop app.

For the desktop app from a production build: `npm run build`, then `npm start -w desktop`.

## How it works

- **Supabase** handles accounts, the database (with row level security) and realtime.
- **Clients** read chats and messages straight from Supabase and subscribe to the private channel `chat:<id>`.
- **Sending** goes to `POST /api/chats/:id/messages` on the server, which checks membership and that the sender has
  a key, saves the message as `pending`, and runs the AI queue (`server/src/run-queue.ts`): one run per chat at a
  time, each answering one person's messages with that person's key and model. The reply streams to everyone as
  broadcast snapshots and is saved when done.
- **API keys** are sent once to `PUT /api/keys/:provider`, checked with the provider, encrypted with AES-256-GCM and
  stored in `user_api_keys`, which only the server can read. Clients only ever see the last 4 characters.

## Security notes

- The server's `SUPABASE_SECRET_KEY` and `KEY_ENCRYPTION_SECRET` never reach a client: Vite only exposes `VITE_*` and
  `NEXT_PUBLIC_*` variables.
- The desktop app runs with context isolation, sandboxing, no Node integration, a strict CSP, and loads its UI from a
  private `app://` origin. Links open in the system browser.
- See `docs/architecture.md` for the design and what is next (shared files between members' computers).
