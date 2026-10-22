# Generative UI (OpenUI) — decisions to review

Built on `dev` without design approval, as asked. Every choice below is my default; each lists the alternatives so it can be changed in one pass.

## What it does

An AI answer can now include small interfaces next to its Markdown: key numbers, tables, bar charts, plans with owners, warnings, choices to pick from, follow-up buttons and short forms. The model writes them in OpenUI Lang inside a fenced `openui-lang` block; the app draws them with its own components (`ui/src/genui/library.tsx`). Clicking an option, a button or a form's submit puts a reply in the clicker's message box, replying to that answer, ready to send or change.

## Decisions

1. **Where generated UI is used: AI chat answers only.**
   Alternatives: also summaries (a decisions / open questions / owners card); also notes; app screens themselves (settings, empty states). Summaries were left Markdown because they are copied and saved as notes; app screens don't change per answer, so generated UI adds nothing there.

2. **How the model writes it: Markdown answer plus optional `openui-lang` fenced blocks (at most 2 asked, 4 drawn).**
   Alternatives: whole answer as OpenUI Lang (OpenUI's default; loses normal Markdown answers); a separate "visual" tool call the model invokes; a per-message "make it visual" button. OpenUI's own inline mode was not used because its prompt is written for a single dashboard that gets edited ("output only the changed statements"), not for chat answers.

3. **Component library: our own small set (Stack, Card, Text, Stat, Table, BarChart+Series, Checklist+Task, Callout, Choice+Option, Buttons+Button, Form+Input+Select), styled with the app's tokens.**
   Alternatives: OpenUI's built-in `@openuidev/react-ui` library (more components: line/pie charts, tabs, date pickers, accordions; but it brings Radix, d3, KaTeX, zustand and its own CSS, and doesn't look like Nido); a mix (built-in charts only). Easy to grow: add a `defineComponent`, run `npm run genui:spec -w ui`.

4. **Clicks draft, they never send.** Options, buttons and forms put the text in the clicker's composer as a reply to the answer; the person presses Enter.
   Alternatives: send immediately (faster, feels more "app-like"); send immediately only when the sent text equals the visible label and has no form values; ask in a confirm popover. Reason: in a shared chat the message goes out under the clicker's name and the AI then acts on it (MCP tools run without per-call approval). A label could say one thing while the message says another, so the person sees the exact text first.

5. **A draft replaces what was already typed in the composer.**
   Alternatives: append under it; refuse and show a notice when the box isn't empty.

6. **Any member can use any answer's interface**, not only the person it answered. Their reply uses their own model and key, like any message.
   Alternatives: only the asker can click; others see it read-only.

7. **Form values are not saved.** Each viewer fills in their own copy; reloading clears it.
   Alternatives: save per person per message (needs a DB column or table and a live migration); save once for the whole chat (a shared form, needs realtime sync).

8. **No live shared state (votes, tallies).** A "Choice" is answered by sending a message, so the chat itself is the record, and the AI can count replies later.
   Alternative: a real shared poll component with a DB table and realtime updates (bigger feature, needs a migration and design).

9. **No data tools inside generated UI.** OpenUI's `Query()` / `Mutation()` / `$variables` are switched off: a visual can't fetch or change anything.
   Alternatives: expose read-only tools (e.g. the project's notes, files list) so visuals can stay live; allow `$variables` for local filters and tabs (cheap, safe, adds prompt size).

10. **Actions offered: `@ToAssistant` (drafts a reply), `@OpenUrl` (http/https only; the desktop app opens https only), and our own `@CopyText`.** The copy toast shows what was copied; hovering a link button shows its address; `@ToAssistant` hidden context is shown in the draft as "Details: …".
    Alternatives: add `@SaveNote` (save to project Notes), `@OpenFile` (open a file from the shared folder), `@Mention` (tag a person).

11. **Always on, for every model and every chat.** Costs about 2,000 extra prompt tokens per answer (cached by providers that cache system prompts).
    Alternatives: a per-project switch in Project settings; a per-person switch in Settings; only for models known to follow it well.

12. **No OpenUI Gateway or Autofix.** Bad blocks fall back to showing their code; nothing else changes.
    Alternatives: route answers through OpenUI Gateway (fixes invalid output while streaming, but every chat goes through a third party and needs a Thesys key); call Autofix only on failed blocks (still sends that block out); ask the model to fix its own block once (costs a second call).

13. **Telemetry off.** `@openuidev/lang-core` sends an anonymous install ping unless `OPENUI_TELEMETRY_DISABLED=1`; the Dockerfile sets it. Runtime telemetry is off by default and stays off. The dev-only OpenUI "Inspect" widget, which loads a script from a CDN, is replaced with an empty module and switched off.
    Alternative: leave the install ping on (it only reports versions and a hashed project id).
    Note: your own `npm install` sends that ping unless you run it as `OPENUI_TELEMETRY_DISABLED=1 npm install`.

14. **The renderer loads lazily**, only when an answer has a visual (200 kB, 61 kB gzipped, separate file). The main bundle is unchanged.
    Alternative: bundle it with the app (no flash of code while it loads).

15. **Copy, Save as note and the summary keep the raw block text.** Reply previews show "[visual]" instead.
    Alternatives: copy/save a Markdown version of the visual (tables as Markdown tables, choices as lists); strip visuals from notes.

16. **Notes draw their visuals** (added 2026-10-22 at Miguel's request). A note with an `openui-lang` block opens like the answer it came from: Markdown plus the visual, in the notes column. Notes without a visual keep the plain-text reader. The editor still shows the raw text. Titles and list previews skip the visual's code ("Visual note", "[visual]").
    Alternatives: render every note as Markdown; render visuals only in notes the AI made; open visual notes in a wider panel or dialog.

17. **A click in a note's visual drafts a message in the chat that is open** (no reply link, since the note isn't a message). With no chat open, the text is copied.
    Alternatives: notes are read-only (buttons, options and forms disabled); always copy; open the chat the note came from (needs storing the source message id).

18. **Visuals in notes render for notes written by anyone in the project**, not only AI-made ones ("Save as note" stores the note as the person's). Same safe components and click rules as in chat.
    Alternative: only render when the note came from an AI answer (needs a "source message" field on notes, a migration).

## How the pieces fit

- `ui/src/genui/library.tsx`: the components (Zod props + React), and `CopyText`.
- `ui/src/genui/GeneratedAnswer.tsx`: splits an answer, draws each block with OpenUI's `Renderer`, handles clicks, falls back to code on errors.
- `shared/src/genui.ts`: answer splitting, reply drafts, previews (tested).
- `shared/src/genui-spec.json`: the library's spec, generated by `npm run genui:spec -w ui`; a UI test fails when it is stale.
- `server/src/genui.ts`: builds the prompt section from the spec with `@openuidev/lang-core`; `run-queue.ts` adds it to chat answers.

## Not verified yet

- No real model has answered with it: the prompt and how often models choose a visual (or overuse it) are untested. Try a few: "compare Supabase and Firebase for us", "plan the launch, Ana and Ben are on it", "what do you need to know to plan our offsite?".
- Not run inside the desktop app (Electron); tested in the browser with a harness that streams a sample answer (dark, light, phone width).
- Models outside the big three (small OpenRouter models, ChatGPT plan) may write invalid blocks more often; they fall back to code.
