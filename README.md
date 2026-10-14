# Multiuser Chat (desktop)

A group chat where everyone shares one AI, as a native desktop app. The UI is drawn with
[GPUI](https://gpui.rs) (pinned to `=0.2.2`), with no web view. Targets macOS and Windows.
Supabase provides accounts, the database and realtime; there is no other server.

## Features

- Sign in with email and password. The session is kept in the OS keychain.
- Chat list, new chat, rename a chat, invite an existing user by email (up to the chat's member limit).
- Messages update live for everyone (Supabase Realtime), and AI replies stream in as they are written.
- **Bring your own key:** each person saves their OpenRouter, Anthropic or OpenAI key under **API keys** and picks
  a model per chat. Keys are stored in the OS keychain and only sent to that provider.

## How AI replies work

Each person's app answers that person's own messages:

1. Sending inserts the message as `pending` (RLS checks membership).
2. The sender's app calls `start_ai_run`, which takes the chat's run lock (one reply at a time per chat), marks the
   sender's pending messages `processing` and creates an empty `streaming` assistant message.
3. The app streams the reply from the provider with the key in its keychain, broadcasting full-text snapshots on the
   private `chat:<id>` channel so everyone sees it being written.
4. `finish_ai_run` saves the reply and releases the lock. A run whose app quit mid-reply is cleaned up when its
   lock expires (5 minutes).

These functions are in `supabase/migrations/0008_client_ai_runs.sql`.

## Run it

1. Install Rust: https://rustup.rs (on Windows, also the "Desktop development with C++" workload of Visual Studio Build Tools).
2. `cp .env.example .env` and fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` (the publishable key). `.env` is gitignored.
3. `cargo run --release`.
   On macOS, `./scripts/bundle-macos.sh` builds `target/MultiuserChat.app` with the Supabase settings built in,
   so it opens like any other app.

macOS builds use GPUI's `runtime_shaders` feature, so Xcode's Command Line Tools are enough.

## Database setup

Run the files in `supabase/migrations/` in order on a Supabase project (SQL editor or `supabase db push`).
For local demos, turn off "Confirm email" under Authentication → Providers → Email.

## Not built yet

- Sign up (create accounts on Supabase for now), invite links, favorite models, a model list from the provider.
- Markdown rendering, selecting or copying message text, multi-line input, typing indicators.
- Keys are per computer: a second computer needs the key entered again.
- Not tested on Windows yet.

## Layout

- `src/theme.rs`: every color, size and font.
- `src/config.rs`: Supabase URL and key.
- `src/backend/`: auth and REST (`mod.rs`), realtime (`realtime.rs`), AI runs (`runner.rs`), provider streaming
  (`ai.rs`), keychain (`keys.rs`), row types (`models.rs`).
- `src/ui/`: sign-in, chat list, chat view (with rename, invite and model editors), API keys, and the text input
  (adapted from the Apache-2.0 `gpui` example).
- `src/runtime.rs`: runs network code on Tokio and hands results back to GPUI.
