// @openuidev/react-lang mounts its "Inspect" widget in development builds, and that widget loads a script from a CDN at a
// floating version. The app never runs remote code, so the auto-mount is switched off before the package loads. Vite also
// replaces @openuidev/devtools with an empty module (web/vite.config.ts); this flag covers any other bundler.
(globalThis as Record<symbol, unknown>)[Symbol.for("openui.devtools.autoMount")] = true;

export {};
