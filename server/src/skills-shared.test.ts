import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanBody, cleanLine, normalizeSkillName, parsePluginManifest, parseSkillMd, skillProblem, SKILL_FULL_NAME_PATTERN, SKILL_NAME_PATTERN } from "@mc/shared";

test("SKILL.md: frontmatter plain, quoted, folded and literal, and the rest is the body", () => {
  const a = parseSkillMd("---\nname: release-notes\ndescription: Write release notes.\nallowed-tools: Read\n---\n# Title\nBody");
  assert.deepEqual(a, { name: "release-notes", description: "Write release notes.", body: "# Title\nBody" });
  assert.equal(parseSkillMd('---\nname: "q"\ndescription: \'It\'s fine\'\n---\nb').description, "It's fine");
  assert.equal(parseSkillMd("---\nname: x\ndescription: >\n  one\n  two\n---\nb").description, "one two");
  assert.equal(parseSkillMd("---\nname: x\ndescription: |\n  one\n  two\n---\nb").description, "one\ntwo");
  assert.equal(parseSkillMd("---\nname: x\ndescription: first\n  continues\n---\nb").description, "first continues");
});

test("SKILL.md: no frontmatter is all body; CRLF and a byte-order mark are fine; it never throws", () => {
  assert.deepEqual(parseSkillMd("Just text"), { name: "", description: "", body: "Just text" });
  assert.deepEqual(parseSkillMd("﻿---\r\nname: a\r\ndescription: d\r\n---\r\nbody\r\n"), { name: "a", description: "d", body: "body" });
  assert.deepEqual(parseSkillMd("---\nname: a\n"), { name: "", description: "", body: "---\nname: a" });
  assert.doesNotThrow(() => parseSkillMd("---\n---\n---\n:::\n"));
});

test("names: normalised from free text, and checked against the pattern", () => {
  assert.equal(normalizeSkillName("Release Notes!"), "release-notes");
  assert.equal(normalizeSkillName("  --Ünï--cödé  "), "n-c-d");
  assert.equal(normalizeSkillName("a".repeat(60)).length, 40);
  assert.equal(normalizeSkillName("***"), "");
  assert.ok(SKILL_NAME_PATTERN.test("a") && SKILL_NAME_PATTERN.test("a-b-9"));
  assert.ok(!SKILL_NAME_PATTERN.test("-a") && !SKILL_NAME_PATTERN.test("a-") && !SKILL_NAME_PATTERN.test("A") && !SKILL_NAME_PATTERN.test("a:b"));
  assert.ok(SKILL_FULL_NAME_PATTERN.test("kit:one") && !SKILL_FULL_NAME_PATTERN.test("a:b:c") && !SKILL_FULL_NAME_PATTERN.test(":a"));
});

test("skill problems are said in words, and a good skill has none", () => {
  const ok = { name: "a", description: "d", body: "b" };
  assert.equal(skillProblem(ok), null);
  assert.match(skillProblem({ ...ok, name: "Bad name" }) ?? "", /name/);
  assert.match(skillProblem({ ...ok, description: "  " }) ?? "", /when to use/);
  assert.match(skillProblem({ ...ok, description: "x".repeat(301) }) ?? "", /300/);
  assert.match(skillProblem({ ...ok, body: " " }) ?? "", /instructions/);
  assert.match(skillProblem({ ...ok, body: "x".repeat(8001) }) ?? "", /8,000/);
});

test("plugin manifest: name normalised, author as text or object, junk refused", () => {
  assert.deepEqual(parsePluginManifest('{"name":"Marketing Kit","version":"1.2","author":{"name":"Acme"},"description":"d"}'), { name: "marketing-kit", version: "1.2", author: "Acme", description: "d" });
  assert.equal(parsePluginManifest('{"name":"x","author":"Bo"}')?.author, "Bo");
  assert.equal(parsePluginManifest("[]"), null);
  assert.equal(parsePluginManifest("nope"), null);
  assert.equal(parsePluginManifest('{"name":"***"}'), null);
  assert.equal(parsePluginManifest('{"name":"x","version":5}')?.version, "");
});

test("cleaning: one line for one-line fields, line breaks kept and control characters dropped for text", () => {
  assert.equal(cleanLine("a\n\tb\u0000 c d", 50), "a b c d");
  assert.equal(cleanLine("x".repeat(20), 5), "xxxxx");
  assert.equal(cleanBody("a\r\nb\u0000c\u0007d\te "), "a\nbcd\te");
});
