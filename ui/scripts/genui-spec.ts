// Writes the spec of the generated-UI library for the server's prompt: npm run genui:spec -w ui
// The ui test genui.test.ts fails when the committed spec is out of date.
import { writeFileSync } from "node:fs";
import { genLibrary } from "../src/genui/library.tsx";

const out = new URL("../../shared/src/genui-spec.json", import.meta.url);
writeFileSync(out, `${JSON.stringify(genLibrary.toSpec(), null, 2)}\n`);
console.log(`wrote ${out.pathname}`);
