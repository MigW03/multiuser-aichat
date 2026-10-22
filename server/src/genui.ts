import { generateSystemPrompt, type LibrarySpec } from "@openuidev/lang-core";
import spec from "@mc/shared/genui-spec.json" with { type: "json" };

/**
 * Instructions that let a chat answer include generated UI (OpenUI Lang) next to its Markdown. The component list comes
 * from the app's own library (ui/src/genui/library.tsx, serialized to shared/src/genui-spec.json), so the model can only
 * name pieces the chat knows how to draw. No tools are offered to the generated UI: it can't fetch or change anything.
 */
const PREAMBLE = `## Visual answers (optional)

Answer in Markdown as usual. When a visual makes the answer clearly easier to use, you may add a block written in openui-lang, a small UI language the chat draws with its own components. Good reasons: comparing options side by side, numbers worth a chart or key figures, a plan with owners, a decision the people in the chat need to make, or a few questions they should fill in. Don't use it for short answers, explanations, code, or anything Markdown already shows well (a simple list or a small table).

Put each block in its own fence marked openui-lang, with your Markdown text before or after it:

\`\`\`openui-lang
root = Stack([...])
\`\`\`

Each block is a complete program on its own: it starts with root = Stack(...) and defines every name it uses. Use at most two blocks in one answer, and keep each one focused. Write everything else, including code examples, as normal Markdown outside the blocks.

The rest of this section describes openui-lang.`;

const RULES = [
  "Only use the components listed above. Never write HTML, CSS or scripts inside a block.",
  "Several people share this chat. When options or forms ask for a decision, the person who clicks gets a drafted reply in their own message box, and sends it under their name.",
  "Use @OpenUrl only for https links you were given or are sure of. Never put secrets, keys or passwords in a block.",
  "Text inside blocks is shown to everyone in the chat: write it for them, in the language of the conversation.",
];

export const genUiInstructions = generateSystemPrompt({
  library: spec as unknown as LibrarySpec,
  promptOptions: {
    preamble: PREAMBLE,
    additionalRules: RULES,
    examples: [
      `Example: comparing two options and asking the group to choose.

\`\`\`openui-lang
root = Stack([table, choice])
table = Table(["", "Supabase", "Firebase"], [["Database", "Postgres", "NoSQL"], ["Pricing from", "$25/mo", "Pay as you go"]])
choice = Choice("Which one should we use?", [optA, optB])
optA = Option("Let's go with Supabase", "SQL and row-level security")
optB = Option("Let's go with Firebase", "Simpler realtime")
\`\`\``,
    ],
  },
});
