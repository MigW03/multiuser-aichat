# Nido coming-soon site

A static page (no build step): `index.html`, `assets/styles.css`, `assets/main.js`, `assets/icon.svg`.

## Run locally

```sh
cd site && python3 -m http.server 4321
```

Open http://localhost:4321. The scroll demo has two versions:

- http://localhost:4321/ starts with three separate AI chats (Ana, Rafael, Leo). Their eggs rise out, gather into the nest, the ring closes, and the ring zooms out into the app.
- http://localhost:4321/?demo=grow skips that story and grows the app window to full page, then plays the chat as you scroll.

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

- Logo: the flat N1C mark (sage ring, ink eggs) is inline SVG in `index.html` and `assets/main.js`. `assets/icon.svg` and `favicon.svg` are the same mark as files. No textured logo styles on the site (Miguel's call).
- Share image (og:image): not added yet. It needs an absolute URL, so it waits for the domain.
- Contact links: the empty `<ul class="contact">` in the footer.
