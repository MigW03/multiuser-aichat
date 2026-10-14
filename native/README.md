# Multiuser Chat — native MVP (Rust + GPUI)

A native desktop client for the same Supabase project as the web prototype. No web view: the UI is drawn with
[GPUI](https://gpui.rs) (pinned to `=0.2.2`). Targets macOS and Windows.

## What works

- Sign in with an existing account (email + password). The session is kept in the OS keychain, so the next launch skips sign-in.
- Chat list, open a chat, create a new chat.
- Messages load from Postgres and update live through Supabase Realtime (Postgres changes on `messages`).
- Sending a message. The AI reply streams in live (the server's broadcast snapshots on the private `chat:<id>` channel).
- The AI uses **your own saved API key and the model you last picked for that chat** in the web app.

## How it fits with the prototype

Nothing in the database or the web app changed.

- Reads go straight to Supabase (REST with your access token, protected by the existing RLS policies).
- Sending goes through the web app's `POST /api/chats/:id/messages`. That route checks your saved key, inserts the
  message and runs the AI queue on the server, because API keys are only readable by the server.
  The native app authenticates to it with the same cookie the web app's `@supabase/ssr` client writes.
- So the web app must be running (locally with `npm run dev`, or deployed) and `CHAT_API_URL` must point at it.

## Run it

1. Install Rust: https://rustup.rs (on Windows, also the "Desktop development with C++" workload of Visual Studio Build Tools).
2. `cp .env.example .env` in this folder and fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the publishable key) and `CHAT_API_URL`.
   The web app's `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` names work too. `.env` is gitignored.
3. Start the web app from the repo root: `npm run dev` (or set `CHAT_API_URL` to your deployed URL).
4. `cargo run --release` in this folder.
   On macOS, `./scripts/bundle-macos.sh` builds `target/MultiuserChat.app`, which behaves like a normal app.

macOS builds use GPUI's `runtime_shaders` feature, so the full Xcode app is not required (Command Line Tools are enough).

## Not built yet

- Sign up, invites, renaming chats, the model picker and API key settings: use the web app for these for now.
- Markdown rendering, selecting or copying message text, multi-line input, typing indicators.
- Not tested on Windows yet (it compiles the same code, but nobody has run it there).

## Layout

- `src/theme.rs` — every color, size and font.
- `src/config.rs` — reads `.env`.
- `src/backend/` — Supabase auth and REST (`mod.rs`), a small Realtime client (`realtime.rs`), row types (`models.rs`).
- `src/ui/` — sign-in, chat list, chat view, and the text input (adapted from the Apache-2.0 `gpui` example).
- `src/runtime.rs` — runs network code on Tokio and hands results back to GPUI.
