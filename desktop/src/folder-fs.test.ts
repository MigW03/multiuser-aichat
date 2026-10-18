import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { FolderError, isHiddenName, listDir, readText, redactSecrets, searchText, splitPath, validateRoot } from "./folder-fs.ts";

const fails = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof FolderError && e.code === code, `expected ${code}`);
};

let root = "";
let outside = "";

before(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mc-folder-")));
  outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "top secret outside the folder");
  root = join(base, "project");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "README.md"), "# Hello\nNeedle in the readme\n");
  writeFileSync(join(root, "src/index.ts"), "export const a = 1;\n// needle here\r\nexport const b = 2;\n");
  // a made-up token in the shape of a real one, built at run time so no scanner mistakes the source for a leak
  const fakeToken = ["sk", "ant", "api03", "x".repeat(40)].join("-");
  writeFileSync(join(root, "src/token.ts"), `const key = "${fakeToken}";\nconst ok = 1; // needle\n`);
  writeFileSync(join(root, ".env"), "SECRET=1 needle");
  writeFileSync(join(root, ".env.local"), "SECRET=2");
  writeFileSync(join(root, ".git/config"), "needle");
  writeFileSync(join(root, "node_modules/pkg/index.js"), "needle");
  writeFileSync(join(root, "dist/out.js"), "needle");
  writeFileSync(join(root, "server.pem"), "needle");
  writeFileSync(join(root, "bin.dat"), Buffer.from([1, 2, 0, 3, 110, 101, 101, 100, 108, 101]));
  writeFileSync(join(root, "big.txt"), Buffer.alloc(3 * 1024 * 1024, 97));
  writeFileSync(join(root, "lines.txt"), Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n"));
  writeFileSync(join(root, "pk.txt"), "before\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\nafter\n");
  symlinkSync(outside, join(root, "link-out"));
  symlinkSync(join(outside, "secret.txt"), join(root, "link-file"));
  symlinkSync(join(root, "src"), join(root, "link-in"));
});

describe("paths", () => {
  test("accepts plain relative paths", () => {
    assert.deepEqual(splitPath("src/index.ts"), ["src", "index.ts"]);
    assert.deepEqual(splitPath(""), []);
    assert.deepEqual(splitPath("./src//index.ts/"), ["src", "index.ts"]);
  });
  test("refuses traversal, absolute paths and odd syntax", () => {
    for (const bad of ["..", "../x", "src/../../x", "/etc/passwd", "C:\\x", "a\\b", "a:b", "a\u0000b", "a\nb", "x".repeat(500), 5, null, undefined]) {
      assert.throws(() => splitPath(bad), (e: unknown) => e instanceof FolderError && e.code === "invalid_path", String(bad));
    }
  });
});

describe("hidden names", () => {
  test("secrets and junk", () => {
    for (const [name, dir] of [[".env", false], [".ENV.local", false], [".env.", false], ["a.pem", false], ["id_rsa", false], ["id_ed25519.pub", false], ["credentials.json", false], ["Secrets", false], [".git", true], ["Node_Modules", true], ["dist", true], [".npmrc", false]] as const) {
      assert.ok(isHiddenName(name, dir), name);
    }
  });
  test("ordinary names stay visible", () => {
    for (const [name, dir] of [["index.ts", false], ["src", true], ["environment.ts", false], ["distance.ts", false], ["keys.ts", false], [".gitignore", false], [".github", true]] as const) {
      assert.ok(!isHiddenName(name, dir), name);
    }
  });
});

describe("list", () => {
  test("lists the folder, dirs first, without hidden or linked entries", async () => {
    const r = await listDir(root, "");
    const names = r.entries.map((e) => e.name);
    assert.deepEqual(names.slice(0, 1), ["src"]);
    assert.ok(names.includes("README.md") && names.includes("lines.txt"));
    for (const hidden of [".git", "node_modules", "dist", ".env", ".env.local", "server.pem", "link-out", "link-file", "link-in"]) assert.ok(!names.includes(hidden), hidden);
    assert.equal(r.entries.find((e) => e.name === "README.md")?.type, "file");
    assert.ok((r.entries.find((e) => e.name === "README.md")?.size ?? 0) > 0);
  });
  test("lists a subfolder", async () => {
    const r = await listDir(root, "src");
    assert.deepEqual(r.entries.map((e) => e.name), ["index.ts", "token.ts"]);
    assert.equal(r.path, "src");
  });
  test("refuses links, hidden folders, files, missing and escapes", async () => {
    await fails(listDir(root, "link-out"), "excluded");
    await fails(listDir(root, "link-in"), "excluded");
    await fails(listDir(root, ".git"), "excluded");
    await fails(listDir(root, "node_modules/pkg"), "excluded");
    await fails(listDir(root, "README.md"), "not_a_directory");
    await fails(listDir(root, "nope"), "not_found");
    await fails(listDir(root, "../outside"), "invalid_path");
    await fails(listDir(root, outside), "invalid_path");
  });
});

describe("read", () => {
  test("reads a file with line numbers", async () => {
    const r = await readText(root, "src/index.ts");
    assert.equal(r.text, "export const a = 1;\n// needle here\nexport const b = 2;");
    assert.deepEqual([r.startLine, r.endLine, r.totalLines, r.truncated], [1, 3, 3, false]);
  });
  test("reads in parts", async () => {
    const r = await readText(root, "lines.txt", 2500, 10);
    assert.equal(r.text.split("\n")[0], "line 2500");
    assert.deepEqual([r.startLine, r.endLine, r.totalLines, r.truncated], [2500, 2509, 3000, true]);
    const first = await readText(root, "lines.txt");
    assert.equal(first.endLine, 2000);
    assert.ok(first.truncated);
  });
  test("refuses hidden, linked, binary, big and escaping files", async () => {
    await fails(readText(root, ".env"), "excluded");
    await fails(readText(root, ".env.local"), "excluded");
    await fails(readText(root, "server.pem"), "excluded");
    await fails(readText(root, ".git/config"), "excluded");
    await fails(readText(root, "link-file"), "excluded");
    await fails(readText(root, "link-out/secret.txt"), "excluded");
    await fails(readText(root, "link-in/index.ts"), "excluded");
    await fails(readText(root, "bin.dat"), "binary");
    await fails(readText(root, "big.txt"), "too_large");
    await fails(readText(root, "src"), "not_a_file");
    await fails(readText(root, "../outside/secret.txt"), "invalid_path");
    await fails(readText(root, "/etc/passwd"), "invalid_path");
    await fails(readText(root, "README.md/x"), "not_found");
  });
  test("redacts tokens and private keys inside shown files", async () => {
    const t = await readText(root, "src/token.ts");
    assert.ok(!t.text.includes("api03"));
    assert.ok(t.text.includes("[redacted secret]"));
    const k = await readText(root, "pk.txt");
    assert.ok(!k.text.includes("MIIEvQ") && k.text.includes("before") && k.text.includes("after"));
  });
});

describe("search", () => {
  test("finds plain text, skipping hidden, linked and binary files", async () => {
    const r = await searchText(root, "NEEDLE");
    const paths = r.matches.map((m) => m.path).sort();
    assert.deepEqual(paths, ["README.md", "src/index.ts", "src/token.ts"]);
    assert.equal(r.matches.find((m) => m.path === "src/index.ts")?.line, 2);
  });
  test("narrows by folder and file pattern", async () => {
    assert.deepEqual((await searchText(root, "needle", "src")).matches.length, 2);
    assert.deepEqual((await searchText(root, "needle", "", "*.md")).matches.map((m) => m.path), ["README.md"]);
    assert.deepEqual((await searchText(root, "needle", "README.md")).matches.length, 1);
  });
  test("treats the query as text, never a pattern", async () => {
    assert.equal((await searchText(root, "(a+)+$")).matches.length, 0);
    assert.equal((await searchText(root, ".*")).matches.length, 0);
  });
  test("refuses bad input", async () => {
    await fails(searchText(root, ""), "bad_request");
    await fails(searchText(root, "x".repeat(200)), "bad_request");
    await fails(searchText(root, "a", "", "../*"), "bad_request");
    await fails(searchText(root, "a", "link-out"), "excluded");
    await fails(searchText(root, "a", ".."), "invalid_path");
  });
  test("redacts tokens in matches", async () => {
    const r = await searchText(root, "sk-ant");
    assert.equal(r.matches.length, 0);
  });
});

describe("root", () => {
  test("accepts a project folder", async () => {
    assert.equal(await validateRoot(root), realpathSync(root));
  });
  test("refuses the disk root, the home folder and its parents, and files", async () => {
    await fails(validateRoot("/"), "invalid_path");
    await fails(validateRoot(homedir()), "invalid_path");
    await fails(validateRoot(join(homedir(), "..")), "invalid_path");
    await fails(validateRoot(join(root, "README.md")), "not_a_directory");
    await fails(validateRoot(join(root, "missing")), "not_a_directory");
  });
  test("redactSecrets leaves normal text alone", () => {
    assert.equal(redactSecrets("const total = a + b; // fine"), "const total = a + b; // fine");
  });
});
