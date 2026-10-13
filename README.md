# Multiuser Chat

A group chat where everyone shares one AI. People write in the same conversation, the AI sees who said what and answers, with realtime updates for everyone.

## Features

- Email/password accounts. Invite another **existing** user to a chat by email (max 2 members for now).
- Chat history is persisted. Chats can be renamed by any member.
- Realtime: messages, AI streaming, typing indicators.
- **Bring your own key:** each person saves their own OpenRouter, Anthropic and/or OpenAI API key and picks their own model. The AI answers a person's messages with that person's key and model.
- Model picker: searchable list loaded live from the provider, favorites, and the model is remembered per chat. OpenRouter models show prices; for other providers the picker points to the provider's pricing.
- AI replies render as markdown.

Not built yet: `@` mentions to skip the AI, projects, more than 2 members, desktop app.

## Design decisions

| Topic | Decision |
|---|---|
| AI replies | After every message |
| Attribution | The model sees `[Name]: text` for each user message |
| Keys | One key per provider per user, encrypted at rest (AES-256-GCM), write-only (the API only returns the last 4 characters), readable only by the server |
| Billing | Each user pays their own provider; there is no shared server key |
| Concurrency | One AI run per chat at a time. A run covers one person's pending messages (their key and model); other people's messages show "Waiting in queue…" and are answered in the following runs |
| Provider prices | Only prices a provider publishes through its own API are shown |
| Desktop later | Keep logic in Supabase and API routes so a Tauri/Electron shell can reuse the same web app |

## How it works

1. `POST /api/chats/[id]/messages` checks the sender has a key for the chosen provider, inserts the message as `pending` (RLS checks membership), then schedules `processChatQueue` with `after()`.
2. `processChatQueue` (`src/lib/ai/run-queue.ts`) takes a per-chat lock (`claim_chat_run`, expires after 5 min), picks the earliest waiting author, marks that author's pending messages `processing`, decrypts their key, streams the reply with the AI SDK, and marks them `done`. It repeats until nothing is pending.
3. Streaming text goes to clients as full-text snapshots over a private Supabase Broadcast channel (`chat:<id>`). The final message is saved to Postgres, and clients receive it through Postgres Changes.
4. Typing indicators and chat renames are client-to-client Broadcast events on the same channel.
5. Keys live in `user_api_keys`, which has row level security on and no access for browser roles; only the server's service key reads it (`src/lib/ai/keys.ts`, `src/lib/crypto.ts`).

## Setup

1. Create a Supabase project and run the files in `supabase/migrations/` in order (`0001` to `0006`), in the SQL editor or with the Supabase CLI.
2. In Supabase, Authentication → Providers → Email: turn off "Confirm email" for local demos.
3. Copy `.env.example` to `.env.local` and fill in the Supabase URL, anon key and secret key. Generate the encryption secret with `openssl rand -base64 32` and set it as `KEY_ENCRYPTION_SECRET`.
4. `npm install && npm run dev`, then open http://localhost:3000.
5. Sign up two accounts (two browsers or one normal and one private window), add an API key under "API keys" for each, create a chat with one, and invite the other by email.

## Deploying (Vercel)

- Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SECRET_KEY` and `KEY_ENCRYPTION_SECRET` as environment variables, and mark the last two Sensitive. Redeploy after changing any of them, because the `NEXT_PUBLIC_` values are baked in at build time.
- Use the same `KEY_ENCRYPTION_SECRET` as every other environment that shares the database. A different secret makes the saved keys unreadable.
- Choose a function region close to your Supabase project. A run is bounded by the route's `maxDuration` (300 s).

## Known limitations

- Reloading the page mid-stream shows the AI bubble empty until the reply finishes (only the final text is stored).
- Messages sent while you were on another page may not appear until you reload.
- No rate limiting on the API key and model routes yet.
- `KEY_ENCRYPTION_SECRET` can't be rotated without users re-entering their keys.
