# Multiuser Chat

A group chat where everyone shares one AI. Two people write in the same conversation, the AI sees who said what, and answers everyone, with realtime updates for both.

## MVP scope

- Email/password accounts. Invite another **existing** user to a chat by email (max 2 members for now).
- One AI chat per invite, history persisted.
- Realtime: messages, AI streaming, typing indicators.
- Message queue: one AI run per chat at a time.

Not in the MVP: `@` mentions to skip the AI, bring-your-own API key, projects, more than 2 members, desktop app.

## Design decisions

| Topic | Decision |
|---|---|
| AI replies | After every message |
| Attribution | The model sees `[Name]: text` for each user message |
| Concurrency | A run finishes before the next starts. Messages that arrive mid-run show "Waiting in queue…" and are answered together in the next run |
| Overlapping messages | The next run takes all pending messages at once; the system prompt tells the model to answer overlapping ones in a single reply |
| Model | OpenRouter with one shared server key (`OPENROUTER_MODEL`) |
| Billing | Demo: the owner pays. Later: each user brings their own key |
| Desktop later | Keep logic in Supabase and API routes so a Tauri/Electron shell can reuse the same web app |

## How it works

1. `POST /api/chats/[id]/messages` inserts the message as `pending` (RLS checks membership), then schedules `processChatQueue` with `after()`.
2. `processChatQueue` (`src/lib/ai/run-queue.ts`) takes a per-chat lock (`claim_chat_run`, expires after 5 min), marks all pending messages `processing`, streams the reply with the AI SDK, and finishes by marking them `done`. It then repeats until nothing is pending.
3. Streaming text goes to clients as full-text snapshots over a private Supabase Broadcast channel (`chat:<id>`). The final message is saved to Postgres, and clients receive it through Postgres Changes.
4. Typing indicators are client-to-client Broadcast events on the same channel.

## Setup

1. Create a Supabase project and run `supabase/migrations/0001_init.sql` in the SQL editor (or with the Supabase CLI).
2. In Supabase, Authentication → Providers → Email: turn off "Confirm email" for local demos.
3. Copy `.env.example` to `.env.local` and fill in the Supabase keys and your OpenRouter key and model.
4. `npm install && npm run dev`, then open http://localhost:3000.
5. Sign up two accounts (two browsers or one normal and one private window), create a chat with one, and invite the other by email.

## Known limitations

- Reloading the page mid-stream shows the AI bubble empty until the reply finishes (only the final text is stored).
- No rate limiting or per-user cost tracking yet. The shared key can be spent by any member.
- On Vercel a run is bounded by the route's `maxDuration` (300 s).
