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

## Desktop app: installers

The installed app is the same web build, packaged with electron-builder. It talks to the live server
(`https://multiuser-chat-server.fly.dev`, baked in at build time; override with `DESKTOP_SERVER_URL`), not localhost.
Build from the repo root (needs `.env.local` for the Supabase values):

| What | Command | Output |
| --- | --- | --- |
| Mac disk image | `npm run dist:mac -w desktop` | `desktop/release/Multiuser Chat-<version>-<arch>.dmg` |
| Windows installer (not tested yet) | `npm run dist:win -w desktop` | `desktop/release/` |
| Unpacked app for a quick look | `npm run pack -w desktop` | `desktop/release/` |

The web build for the installer goes to `desktop/web-dist`, so `web/dist` (the website) is untouched. Set
`DESKTOP_WEB_URL` (https) at build time to make "Copy link to chat" give website links; unset, it gives
`multiuserchat://open#/...` links that only work for people who have the desktop app.

**Not signed yet.** The Mac app is ad-hoc signed only (no Apple Developer ID, no notarization). Opening a downloaded
copy shows "Apple could not verify..." or "is damaged": right-click the app > Open, or System Settings > Privacy &
Security > Open Anyway, or run `xattr -dr com.apple.quarantine "/Applications/Multiuser Chat.app"` once. A copy you
built yourself opens without that. Windows shows a SmartScreen "unknown publisher" warning the same way.

**Email links.** The app registers `multiuserchat://`. Confirmation and password-reset emails sent from the desktop
app point to `multiuserchat://auth`, which opens the app and signs in. Add `multiuserchat://auth` to Supabase >
Authentication > URL Configuration > Redirect URLs. Until it is listed, Supabase falls back to the Site URL (the
website): the link still confirms the account and you log in on the desktop app with your password. Invite links
point at the website; in the desktop app use **Join with a link** and paste the link. Deep links only work in an
installed build, not in `npm run dev:desktop`.

## Deploy the web app (Vercel)

The web app is a static Vite build; the server (`server/`) is a separate Node service and does not go on Vercel.
Two setups work, and each has its own `vercel.json`:

| Root Directory | Config used | Notes |
| --- | --- | --- |
| `web` | `web/vercel.json` | Turn on **Include source files outside of the Root Directory in the Build Step** (Project Settings > General). The build imports `ui/` and `shared/` from the repo root. |
| repo root (empty) | `vercel.json` | Builds the `web` workspace and publishes `web/dist`. |

Both install with `npm ci` from the repo root and skip the Electron binary download. Use Node 22.12 or newer (Vercel's
default 24.x is fine). Set these under Project Settings > Environment Variables (they are public, baked into the bundle at
build time, so **redeploy after changing them**):

| Variable | Production | Preview | Local dev (`.env.local`) |
| --- | --- | --- | --- |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | your Supabase project | same | same |
| `VITE_SERVER_URL` | `https://multiuser-chat-server.fly.dev` | leave unset (see below) | leave unset: defaults to `http://localhost:8787`, the server `npm run dev` starts |

So `npm run dev` talks to your local server and the Vercel Production deploy talks to the Fly server. A hosted build
without `VITE_SERVER_URL` shows an error instead of calling a server on the visitor's own computer. Preview deploys
have their own address, which the Fly server's `ALLOWED_ORIGINS` does not list, so leave the variable unset there; to
try a preview against Fly anyway, set it for Preview too and add that preview address to `ALLOWED_ORIGINS`. Both
environments currently share one Supabase project (same accounts and chats); a separate live project would keep test
data apart. Never add `SUPABASE_SECRET_KEY` or `KEY_ENCRYPTION_SECRET` to the web project; they belong only to the server.
Routes use
the URL hash, so no rewrites are needed. Add the deployed address to Supabase's redirect URL allow-list and to the server's
`ALLOWED_ORIGINS` and `APP_URL`.

## Deploy the server (Fly.io)

`fly.toml` and `server/Dockerfile` run the server on one small Fly machine (`shared-cpu-1x`, 512 MB, region `gru`).
Keep it at **one machine**: rate limits and the run queue live in the process's memory (queued messages are saved
in the database and picked up again at boot, but two machines would both run the same chat).

**Server environment** (set with `fly secrets set`, never in `fly.toml` or git):

| Name | What |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL (https) |
| `SUPABASE_SECRET_KEY` | Supabase secret (service role) key |
| `KEY_ENCRYPTION_SECRET` | `openssl rand -base64 32`; losing or changing it makes stored API keys unreadable |
| `ALLOWED_ORIGINS` | Comma-separated web origins, e.g. `https://chat.example.com,app://desktop` |
| `APP_URL` | The web app's public address (https), used in invite links |
| `SERVER_URL` | Optional. This server's own public address (https), the redirect for OAuth sign-in to remote MCP servers. Unset: OAuth sign-in is off |
| `RESEND_API_KEY`, `MAIL_FROM` | Optional, to email invites |

`PORT`, `HOST` and `TRUST_PROXY` are already set in `fly.toml`. The web app gets the server's address at build time
as `VITE_SERVER_URL` (for example `https://multiuser-chat-server.fly.dev`; see the Vercel section).

**First deploy** (once, from the repo root):

```sh
fly apps create multiuser-chat-server        # or pick another name and change `app` in fly.toml
fly secrets set --stage SUPABASE_URL=... SUPABASE_SECRET_KEY=... KEY_ENCRYPTION_SECRET=... ALLOWED_ORIGINS=... APP_URL=...
fly deploy --ha=false
curl https://multiuser-chat-server.fly.dev/health   # {"ok":true}
```

Later deploys are `fly deploy`. Check `fly status`: it must list exactly one machine.

**Night shutdown.** The machine is off from 23:00 to 06:00 in Brasília (02:00-09:00 UTC, Brazil has no daylight
saving) to save cost. Fly has no cron stop/start, so two [cron-job.org](https://cron-job.org) jobs call the Fly Machines
API: stop at 23:00 and start at 06:00. `.github/workflows/fly-wake.yml` is only a manual
start/stop button (Actions tab > fly-wake > Run workflow; needs the `FLY_API_TOKEN` secret). `auto_start_machines` is off in `fly.toml`; otherwise the
first request at night would wake the machine and save nothing.

Set it up once, after the first deploy:

1. Token: `fly tokens create deploy -a multiuser-chat-server`. It is scoped to this app. Paste it only into the
   cron-job.org headers below and, for the manual button, the GitHub secret `FLY_API_TOKEN` (Settings > Secrets and
   variables > Actions).
   Never into the repo, chat or `fly.toml`.
2. Machine id: `fly machine list -a multiuser-chat-server` (a 14-character id like `148e2d1b9e4528`). It stays the
   same across `fly deploy`; if the machine is ever destroyed and recreated, update both jobs.
3. On cron-job.org create two jobs (CREATE CRONJOB). Both use URL `https://api.machines.dev/v1/apps/multiuser-chat-server/machines/<MACHINE_ID>/stop`
   (job 1) or `.../start` (job 2) and the same advanced settings:
   - Method `POST`, request body `{}`.
   - Headers: `Authorization` = the token exactly as `fly tokens create` printed it (starts with `FlyV1 `), and
     `Content-Type` = `application/json`. If the first test gives 401, use `Bearer ` plus the token instead.
   - Schedule (Custom): time zone `America/Sao_Paulo`; job 1 at 23:00 every day, job 2 at 06:00 every day.
   - Notifications: turn on "Notify me when the execution of the cronjob fails" (and "when the job gets disabled").
   - Save, then use **Test run** (the stop job really stops the machine; run the start job after it). The response
     should be `200` with `{"ok":true}`; confirm with `fly status`.

While it is stopped, nobody can send messages, manage keys or invites; reading old chats still works (clients read
Supabase directly). Stopping drops open connections and the in-memory queue: an answer being written at 23:00 is cut
off (it shows "The reply was interrupted"), and at boot `recoverRuns` puts messages that were waiting or being
answered back in the queue.

`fly deploy` starts a stopped machine, so a deploy at night keeps it on until the
next 23:00 stop; stop it by hand with the fly-wake workflow if that matters.

## Supabase setup

Run the migrations in `supabase/migrations` in order (the SQL editor or `supabase db push`). Then, under
Authentication:

- **Providers > Email:** turn on **Confirm email**. Invites are locked to the invited address, and that only means
  something when people have to prove they own it.
- **URL Configuration:** add the web app's address (for example `http://localhost:5173`) to the redirect URL
  allow-list, so the links in confirmation and password reset emails come back to the app. Add `multiuserchat://auth`
  too, so the desktop app gets sign-in links (email and Google) back.
- **Providers > Google** (optional: without it the Google button shows an error): create an OAuth client of
  type "Web application" in Google Cloud Console, with `https://<project>.supabase.co/auth/v1/callback` as its authorized
  redirect URI. Ask only for `openid email profile`, and publish the consent screen so anyone can sign in. Paste the
  client ID and secret into the Supabase Google provider and turn it on. Keep **Confirm email** on: a Google account
  whose email matches an email account is linked to it automatically. Migration `0019` takes the new person's name from
  Google. The desktop app opens Google in the system browser and comes back through `multiuserchat://auth`; a dev run
  of the desktop app has no such link, so it hides the Google button.

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
