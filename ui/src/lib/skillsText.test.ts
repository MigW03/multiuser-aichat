import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillItem, SkillsList } from "@mc/shared";
import { styleMarkdown } from "./markdownLive.ts";
import { markSkillTokens, matchSkills, skillMenu, slashToken } from "./skillsText.ts";

const sk = (name: string, o: Partial<SkillItem> = {}): SkillItem => ({ id: name, name, description: `d ${name}`, auto_use: true, enabled: true, plugin_id: null, scope: "mine", by: null, updated_at: "", ...o });
const list = (mine: SkillItem[], project?: SkillItem[], off: string[] = []): SkillsList => ({
  mine: { skills: mine, plugins: off.map((id) => ({ id, name: id, version: "", author: "", description: "", enabled: false, scope: "mine" as const, by: null, updated_at: "" })) },
  ...(project ? { project: { skills: project, plugins: [] } } : {}),
});

test("the menu has switched-on skills only, the project wins a clash, plugin skills need their plugin on", () => {
  const menu = skillMenu(list([sk("b"), sk("off", { enabled: false }), sk("kit:one", { plugin_id: "kit" }), sk("x:two", { plugin_id: "x" })], [sk("b", { scope: "project", description: "project b" })], ["x"]));
  assert.deepEqual(menu.map((m) => [m.name, m.from, m.description]), [["b", "project", "project b"], ["kit:one", "kit", "d kit:one"]]);
  assert.deepEqual(skillMenu(null), []);
});

test("slash token: only at the start or after a space, with what follows", () => {
  assert.deepEqual(slashToken("/rel", 4), { start: 0, query: "rel" });
  assert.deepEqual(slashToken("write /kit:se", 13), { start: 6, query: "kit:se" });
  assert.equal(slashToken("a/b", 3), null);
  assert.equal(slashToken("/usr/bin", 8), null);
  assert.deepEqual(slashToken("/", 1), { start: 0, query: "" });
});

test("matches by start of the name, then of the part after the plugin, then anywhere", () => {
  const menu = ["release-notes", "kit:review", "my-release", "zzz"].map((name) => ({ name, description: "", from: "mine" }));
  assert.deepEqual(matchSkills(menu, "rev").map((m) => m.name), ["kit:review"]);
  assert.deepEqual(matchSkills(menu, "rel").map((m) => m.name), ["release-notes", "my-release"]);
  assert.deepEqual(matchSkills(menu, "").length, 4);
  assert.equal(matchSkills(menu, "q").length, 0);
});

test("marking skill names never changes the text", () => {
  const text = "ask /release-notes for v1, not /nope or /usr/bin and `/release-notes`";
  const lines = markSkillTokens(styleMarkdown(text), new Set(["release-notes"]));
  assert.equal(lines.map((l) => l.spans.map((s) => s.text).join("")).join("\n"), text);
  const marked = lines.flatMap((l) => l.spans.filter((s) => s.kind === "skill").map((s) => s.text));
  assert.deepEqual(marked, ["/release-notes"]);
});
