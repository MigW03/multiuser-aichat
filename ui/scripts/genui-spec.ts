// Writes the specs of the generated-UI libraries for the server's prompts: npm run genui:spec -w ui
// The ui test genui.test.ts fails when a committed spec is out of date.
import { writeFileSync } from "node:fs";
import { genLibrary } from "../src/genui/library.tsx";
import { panelLibrary } from "../src/genui/panel-library.tsx";

for (const [file, library] of [
  ["genui-spec.json", genLibrary],
  ["panel-spec.json", panelLibrary],
] as const) {
  const out = new URL(`../../shared/src/${file}`, import.meta.url);
  writeFileSync(out, `${JSON.stringify(library.toSpec(), null, 2)}\n`);
  console.log(`wrote ${out.pathname}`);
}
