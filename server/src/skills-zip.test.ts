import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { PluginFileError, readPluginFile } from "./skills-zip.ts";

const skill = (n: string, d: string, b: string) => strToU8(`---\nname: ${n}\ndescription: ${d}\n---\n${b}`);
const manifest = (o: object = { name: "Marketing Kit", version: "1.2", author: { name: "Acme" }, description: "Helpers" }) => strToU8(JSON.stringify(o));

test("reads a plugin inside one folder, and counts what it leaves out", () => {
  const z = zipSync({
    "kit/plugin.json": manifest(),
    "kit/skills/brand-voice/SKILL.md": skill("brand-voice", "Check copy.", "# Voice\nBe warm."),
    "kit/skills/seo-audit/SKILL.md": strToU8("---\nname: seo-audit\ndescription: >\n  Audit a page\n  for SEO.\n---\nDo it."),
    "kit/skills/seo-audit/scripts/run.py": strToU8("print(1)"),
    "kit/commands/go.md": strToU8("x"),
    "kit/hooks/hooks.json": strToU8("{}"),
    "kit/.mcp.json": strToU8("{}"),
    "kit/README.md": strToU8("hi"),
    "__MACOSX/kit/._plugin.json": strToU8("junk"),
  });
  const r = readPluginFile(z);
  assert.equal(r.manifest.name, "marketing-kit");
  assert.equal(r.manifest.author, "Acme");
  assert.deepEqual(r.skills.map((s) => [s.name, s.problem]), [["brand-voice", null], ["seo-audit", null]]);
  assert.equal(r.skills[1]!.description, "Audit a page for SEO.");
  assert.deepEqual(r.left_out, { commands: 1, mcp: 1, hooks: 1, scripts: 1, other: 0 });
});

test("reads a plugin with files at the top and the .claude-plugin manifest", () => {
  const z = zipSync({ ".claude-plugin/plugin.json": manifest({ name: "x" }), "skills/one/SKILL.md": skill("one", "d", "b") });
  assert.equal(readPluginFile(z).skills.length, 1);
});

test("a skill with no description, or a repeated name, is listed with a problem and not dropped", () => {
  const z = zipSync({
    "plugin.json": manifest({ name: "x" }),
    "skills/a/SKILL.md": strToU8("---\nname: same\n---\nbody"),
    "skills/b/SKILL.md": skill("same", "d", "b"),
    "skills/c/SKILL.md": skill("same", "d", "b"),
  });
  const r = readPluginFile(z);
  assert.match(r.skills[0]!.problem ?? "", /when to use/);
  assert.equal(r.skills[1]!.problem, null);
  assert.match(r.skills[2]!.problem ?? "", /same name/);
});

test("refuses files that are not plugins", () => {
  const refuse = (data: Uint8Array, re: RegExp) => assert.throws(() => readPluginFile(data), (e) => e instanceof PluginFileError && re.test(e.message));
  refuse(new Uint8Array(), /empty/);
  refuse(strToU8("hello world"), /not a \.zip/);
  refuse(zipSync({ "skills/a/SKILL.md": skill("a", "d", "b") }), /plugin\.json/);
  refuse(zipSync({ "plugin.json": manifest({ name: "x" }) }), /no skills/);
  refuse(zipSync({ "plugin.json": strToU8("{not json"), "skills/a/SKILL.md": skill("a", "d", "b") }), /plugin\.json could not be read/);
  refuse(zipSync({ "plugin.json": manifest({ name: "x" }), "../evil/SKILL.md": skill("a", "d", "b") }), /unsafe path/);
  refuse(zipSync({ "plugin.json": manifest({ name: "x" }), "/abs/skills/a/SKILL.md": skill("a", "d", "b") }), /unsafe path/);
});

test("refuses too many files, too many skills, and a file over 1 MB", () => {
  const many: Record<string, Uint8Array> = { "plugin.json": manifest({ name: "x" }), "skills/a/SKILL.md": skill("a", "d", "b") };
  for (let i = 0; i < 520; i++) many[`f/${i}.txt`] = strToU8("x");
  assert.throws(() => readPluginFile(zipSync(many)), /more than 500/);
  const skills: Record<string, Uint8Array> = { "plugin.json": manifest({ name: "x" }) };
  for (let i = 0; i < 21; i++) skills[`skills/s${i}/SKILL.md`] = skill(`s${i}`, "d", "b");
  assert.throws(() => readPluginFile(zipSync(skills)), /20 skills at most/);
  assert.throws(() => readPluginFile(new Uint8Array(1_000_001).fill(0x50)), /over 1 MB/);
});

test("an oversized SKILL.md is not opened and is listed with a problem", () => {
  const big = strToU8(`---\nname: big\ndescription: d\n---\n${"x".repeat(100_000)}`);
  const z = zipSync({ "plugin.json": manifest({ name: "x" }), "skills/big/SKILL.md": big });
  const r = readPluginFile(z);
  assert.match(r.skills[0]!.problem ?? "", /too large/);
});

test("a skill body over 8,000 characters is listed with a problem", () => {
  const z = zipSync({ "plugin.json": manifest({ name: "x" }), "skills/long/SKILL.md": skill("long", "d", "x".repeat(9000)) });
  assert.match(readPluginFile(z).skills[0]!.problem ?? "", /8,000/);
});

test("a file with the ZIP64 end records is refused before it is parsed", () => {
  const z = zipSync({ "plugin.json": manifest({ name: "x" }), "skills/a/SKILL.md": skill("a", "d", "b") });
  const withRecord = new Uint8Array(z.length + 4);
  withRecord.set(z);
  withRecord.set([0x50, 0x4b, 0x06, 0x07], z.length);
  assert.throws(() => readPluginFile(withRecord), /ZIP64/);
});

test("a zip that says its skill is small but is not opens at the size it says, never bigger", () => {
  const big = strToU8(`---\nname: big\ndescription: d\n---\n${"x".repeat(300_000)}`);
  const z = zipSync({ "plugin.json": manifest({ name: "x" }), "skills/big/SKILL.md": big });
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  for (let i = 0; i < z.length - 28; i++) {
    if (dv.getUint32(i, true) === 0x04034b50 && dv.getUint32(i + 22, true) === big.length) dv.setUint32(i + 22, 1000, true);
    if (dv.getUint32(i, true) === 0x02014b50 && dv.getUint32(i + 24, true) === big.length) dv.setUint32(i + 24, 1000, true);
  }
  const r = readPluginFile(z);
  assert.ok(r.skills[0]!.body.length <= 1000);
});
