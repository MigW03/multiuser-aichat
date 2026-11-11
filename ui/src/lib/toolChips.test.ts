import assert from "node:assert/strict";
import { test } from "node:test";
import { chipFileNames, toolChips } from "./toolChips.ts";

test("no tools used: no chips", () => {
  assert.deepEqual(toolChips({}), []);
});

test("edits first, then reads, then connected tools", () => {
  const chips = toolChips({ edits: [{ p: "src/a.ts", ok: true }], files: ["README.md"], mcp: ["Vercel: list_deployments"] });
  assert.deepEqual(chips.map((c) => [c.kind, c.label]), [["edit", "Edited a.ts"], ["read", "Read README.md"], ["mcp", "Vercel: list_deployments"]]);
});

test("a change that was not applied is marked failed", () => {
  assert.equal(toolChips({ edits: [{ p: "a.ts", ok: false }] })[0]?.kind, "failed");
});

test("a file read and edited shows once, repeated entries collapse", () => {
  const chips = toolChips({ edits: [{ p: "a.ts", ok: true }, { p: "a.ts", ok: true }], files: ["a.ts", "b.ts", "b.ts"], mcp: ["x: y", "x: y"] });
  assert.deepEqual(chips.map((c) => c.key), ["e:a.ts", "r:b.ts", "m:x: y"]);
});

test("file names for dedupe", () => {
  assert.deepEqual([...chipFileNames(toolChips({ files: ["src/a.ts"], mcp: ["s: t"] }))], ["a.ts"]);
});

test("a skill the AI followed shows as a chip, before the connected tools", () => {
  const chips = toolChips({ skills: ["release-notes", "kit:seo", "release-notes"], mcp: ["Vercel: list_deployments"] });
  assert.deepEqual(chips.map((c) => [c.kind, c.label]), [["skill", "Skill: release-notes"], ["skill", "Skill: kit:seo"], ["mcp", "Vercel: list_deployments"]]);
});
