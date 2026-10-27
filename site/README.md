# Nido coming-soon site

A static page (no build step): `index.html`, `assets/styles.css`, `assets/main.js`, `assets/icon.svg`.

## Run locally

```sh
cd site && python3 -m http.server 4321
```

Open http://localhost:4321. The scroll demo has two versions:

- http://localhost:4321/ grows the app window to full page and plays the chat as you scroll.
- http://localhost:4321/?demo=merge starts with two separate AI chats that merge into Nido first (experimental).

With reduced motion turned on (or without JavaScript) the demo is a still window with the whole conversation.

## Forms

The waitlist and the roadmap ideas go to the Supabase project through two functions, `join_waitlist` and
`submit_idea` (migration `supabase/migrations/0025_site_waitlist_and_ideas.sql`). The page only has the publishable
key, and that key can call those two functions and nothing else on these tables. Read the entries in the Supabase
dashboard: tables `site_waitlist` and `site_ideas`.

## Deploy (Vercel)

New Vercel project from this repo, Root Directory `site`, Framework "Other", no build command. `site/vercel.json` sets
the security headers. If the Supabase project changes, update `SUPABASE_URL` / `SUPABASE_KEY` in `assets/main.js` and
`connect-src` in `vercel.json`.

## Placeholders

- Logo: `assets/icon.svg` is the iOS blank app icon. Replace the file to swap the logo everywhere.
- Contact links: the empty `<ul class="contact">` in the footer.
