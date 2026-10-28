# Nido logo

The mark is a nest seen from above: one ring and three eggs. Ring = accent colour (Sage `#9db38f` by default), eggs = ink (`#1f241b` on light, `#ebeee6` on dark).

- Source of truth: `ui/src/lib/logo.ts`. The in-app mark (`BrandMark` in `ui/src/components/Auth.tsx`) and the favicon are drawn from it.
- In the app the ring uses `var(--p)` and the eggs `var(--fg)`, so the logo follows the accent and the theme. `applyTheme` also repoints the page's SVG favicon at the current accent (`ui/src/lib/favicon.ts`).
- Files here are the Sage defaults, for use outside the app: `logo-mark*.svg`, `app-icon.svg`, `app-icon-1024.png`, `logo-lockup-light.png`, `logo-lockup-dark.png`.
- Regenerate everything (these files, `web/public/*` icons, `desktop/build/icon.png`, `site/assets/icon.svg` and `favicon.svg`) with `npx tsx brand/make-assets.mjs`. It needs Playwright with Chromium; it is not a project dependency.
- The installed desktop app icon and the touch icon are fixed at build time and stay Sage; only the in-app logo and the browser tab icon follow a custom accent.
