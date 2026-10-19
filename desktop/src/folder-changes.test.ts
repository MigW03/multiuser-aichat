import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { Approvals } from "./folder-approvals.ts";
import { commitStaged, stageChange } from "./folder-changes.ts";
import { FolderError } from "./folder-fs.ts";
import { nameItems, type Item } from "./folder-items.ts";

const fails = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof FolderError && e.code === code, `expected ${code}`);
};

let root = "";
let outside = "";
let items: Item[] = [];
let n = 0;
/** Paths inside the shared folder start with the folder's name, as they do for the project's members. Escapes and absolute paths stay as they are. */
const at = (path: string) => (path.startsWith("/") || path.startsWith("..") ? path : `${items[0]!.name}/${path}`);
const edit = (path: string, oldString: string, newString: string, extra: object = {}) => ({ id: `e${++n}`, op: "edit", path: at(path), oldString, newString, ...extra });
const write = (path: string, content: string, hadRead = true) => ({ id: `w${++n}`, op: "write", path: at(path), content, hadRead });

before(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mc-changes-")));
  outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "target.txt"), "outside");
  root = join(base, "project");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(root, "tool.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  writeFileSync(join(root, "src/token.ts"), `const k = "${["sk", "ant", "api03", "x".repeat(40)].join("-")}";\n`);
  writeFileSync(join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  writeFileSync(join(root, ".env"), "A=1");
  writeFileSync(join(root, "ro.txt"), "read only\n");
  chmodSync(join(root, "ro.txt"), 0o444);
  symlinkSync(join(outside, "target.txt"), join(root, "link.txt"));
  symlinkSync(outside, join(root, "linkdir"));
  items = nameItems([{ abs: root, kind: "dir" }]);
});

describe("stageChange", () => {
  test("an edit builds a diff and writes nothing", async () => {
    const s = await stageChange(items, edit("src/a.ts", "const b = 2", "const b = 3"));
    assert.equal(s.created, false);
    assert.equal(s.change.path, at("src/a.ts"));
    assert.equal(s.change.added, 1);
    assert.equal(s.change.removed, 1);
    assert.match(s.change.diff, /-export const b = 2;/);
    assert.match(s.change.diff, /\+export const b = 3;/);
    assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "export const a = 1;\nexport const b = 2;\n");
  });

  test("refuses paths the reads refuse", async () => {
    await fails(stageChange(items, edit("../outside/target.txt", "o", "x")), "invalid_path");
    await fails(stageChange(items, edit("/etc/passwd", "o", "x")), "invalid_path");
    await fails(stageChange(items, edit(".env", "A=1", "A=2")), "excluded");
    await fails(stageChange(items, write(".env", "A=2")), "excluded");
    await fails(stageChange(items, write(".env.local", "A=2")), "excluded");
    await fails(stageChange(items, write("deploy.pem", "x")), "excluded");
    await fails(stageChange(items, write(".git/hooks/pre-commit", "#!/bin/sh")), "excluded");
    await fails(stageChange(items, write("node_modules/x/index.js", "x")), "excluded");
    await fails(stageChange(items, write("src/.env.", "x")), "excluded");
    await fails(stageChange(items, edit("link.txt", "outside", "x")), "excluded");
    await fails(stageChange(items, write("link.txt", "x")), "excluded");
    await fails(stageChange(items, write("linkdir/new.txt", "x")), "excluded");
    await fails(stageChange(items, write("linkdir/target.txt", "x")), "excluded");
    await fails(stageChange(items, edit("", "a", "b")), "not_a_file");
    await fails(stageChange(items, write("src", "x")), "not_a_file");
    await fails(stageChange(items, write("src/a.ts/inner.txt", "x")), "not_a_directory");
  });

  test("refuses files that are not plain text or that hold a secret", async () => {
    await fails(stageChange(items, edit("bin.dat", "a", "b")), "binary");
    await fails(stageChange(items, edit("latin1.txt", "caf", "cafe")), "binary");
    await fails(stageChange(items, edit("src/token.ts", "const", "let")), "secrets");
    await fails(stageChange(items, edit("src/a.ts", "const b = 2", `const k = "${["sk", "ant", "api03", "y".repeat(40)].join("-")}"`)), "secrets");
    await fails(stageChange(items, write("new.ts", `x = "${["gh", "p"].join("")}_${"a".repeat(36)}"`)), "secrets");
  });

  test("bad input and limits", async () => {
    await fails(stageChange(items, edit("nope.ts", "a", "b")), "not_found");
    await fails(stageChange(items, { id: "x1", op: "edit", path: at("src/a.ts"), oldString: 5, newString: "b" }), "bad_request");
    await fails(stageChange(items, edit("src/a.ts", "const a = 1;", "const a = 1;")), "bad_request");
    await fails(stageChange(items, write("big.txt", "a".repeat(600_000))), "bad_request");
    await fails(stageChange(items, write("zero.txt", "a\0b")), "bad_request");
    await fails(stageChange(items, write("src/a.ts", "export const a = 1;\nexport const b = 2;\n")), "bad_request");
    await fails(stageChange(items, write("src/a.ts", "replaced\n", false)), "exists");
    await fails(stageChange(items, edit("src/a.ts", "zzz", "b")), "no_match");
  });

  test("a new file is a created diff", async () => {
    const s = await stageChange(items, write("docs/guide/intro.md", "# Intro\n"));
    assert.equal(s.created, true);
    assert.equal(s.change.added, 1);
    assert.equal(existsSync(join(root, "docs")), false);
  });

  test("device names are refused, as on Windows", async () => {
    await fails(stageChange(items, write("con.txt", "x")), "excluded");
    await fails(stageChange(items, write("src/NUL", "x")), "excluded");
    await fails(stageChange(items, write("docs/com1.log", "x")), "excluded");
    await stageChange(items, write("src/console.txt", "x")); // only the exact device names
  });

  test("two big, very different files still get a diff quickly", async () => {
    const rnd = (seed: number) => Array.from({ length: 12_000 }, (_, i) => `line ${(i * 7919 + seed) % 100003} ${"x".repeat(i % 20)}`).join("\n") + "\n";
    writeFileSync(join(root, "huge.txt"), rnd(1));
    const t0 = Date.now();
    const s = await stageChange(items, write("huge.txt", rnd(54321)));
    assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0} ms`);
    assert.ok(s.change.added > 0 && s.change.removed > 0);
  });

  test("a long diff is cut", async () => {
    const s = await stageChange(items, write("long.txt", Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n")));
    assert.equal(s.change.cut, true);
    assert.ok(s.change.diff.length < 41_000);
  });
});

describe("commitStaged", () => {
  test("writes an approved edit, keeping the mode", async () => {
    const s = await stageChange(items, edit("tool.sh", "echo hi", "echo ho"));
    await commitStaged(s);
    assert.equal(readFileSync(join(root, "tool.sh"), "utf8"), "#!/bin/sh\necho ho\n");
    assert.equal(statSync(join(root, "tool.sh")).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(root).filter((f) => f.endsWith(".tmp")), []);
  });

  test("creates a file and its folders", async () => {
    const s = await stageChange(items, write("docs/guide/intro.md", "# Intro\n"));
    await commitStaged(s);
    assert.equal(readFileSync(join(root, "docs/guide/intro.md"), "utf8"), "# Intro\n");
  });

  test("a changed file is refused: the approval was for another version", async () => {
    writeFileSync(join(root, "src/b.ts"), "one\ntwo\n");
    const s = await stageChange(items, edit("src/b.ts", "two", "2"));
    writeFileSync(join(root, "src/b.ts"), "one\ntwo changed by someone\n");
    await fails(commitStaged(s), "stale");
    assert.equal(readFileSync(join(root, "src/b.ts"), "utf8"), "one\ntwo changed by someone\n");
  });

  test("a file replaced by another file with the same text is refused too (new inode)", async () => {
    writeFileSync(join(root, "src/c.ts"), "same\n");
    const s = await stageChange(items, edit("src/c.ts", "same", "other"));
    writeFileSync(join(root, "src/c.tmp2"), "same\n");
    (await import("node:fs")).renameSync(join(root, "src/c.tmp2"), join(root, "src/c.ts"));
    await fails(commitStaged(s), "stale");
  });

  test("a file that appeared meanwhile is not overwritten", async () => {
    const s = await stageChange(items, write("src/new.ts", "mine\n"));
    writeFileSync(join(root, "src/new.ts"), "theirs\n");
    await fails(commitStaged(s), "stale");
    assert.equal(readFileSync(join(root, "src/new.ts"), "utf8"), "theirs\n");
  });

  test("a path turned into a link after approval is refused", async () => {
    writeFileSync(join(root, "src/d.ts"), "d\n");
    const s = await stageChange(items, edit("src/d.ts", "d", "dd"));
    (await import("node:fs")).rmSync(join(root, "src/d.ts"));
    symlinkSync(join(outside, "target.txt"), join(root, "src/d.ts"));
    await fails(commitStaged(s), "excluded");
    assert.equal(readFileSync(join(outside, "target.txt"), "utf8"), "outside");
  });

  test("a read-only file is not changed", async () => {
    const s = await stageChange(items, edit("ro.txt", "read only", "changed"));
    await fails(commitStaged(s), "failed");
    assert.equal(readFileSync(join(root, "ro.txt"), "utf8"), "read only\n");
  });
});

describe("Approvals", () => {
  const hooks = () => {
    const added: string[] = [];
    const gone: string[] = [];
    let allowed = true;
    return { added, gone, set: (v: boolean) => (allowed = v), hooks: { onAdd: (v: { id: string }) => added.push(v.id), onGone: (_p: string, id: string) => gone.push(id), stillAllowed: () => allowed, confirm: async () => true } };
  };

  test("nothing is written until the host approves; approving writes once", async () => {
    writeFileSync(join(root, "src/e.ts"), "x\n");
    const h = hooks();
    const a = new Approvals(h.hooks);
    const s = await stageChange(items, edit("src/e.ts", "x", "y"));
    const pending = a.propose("p", s, { askedBy: "Ana", readFiles: 2 });
    assert.deepEqual(h.added, [s.id]);
    assert.equal(readFileSync(join(root, "src/e.ts"), "utf8"), "x\n");
    assert.equal(a.count("p"), 1);
    assert.equal(await a.decide("p", s.id, true), true);
    assert.equal(await a.decide("p", s.id, true), false); // a second click does nothing
    const res = await pending;
    assert.equal(res.ok, true);
    assert.equal(readFileSync(join(root, "src/e.ts"), "utf8"), "y\n");
    assert.deepEqual(h.gone, [s.id]);
  });

  test("deny, expire, cancel and a wrong project leave the file alone", async () => {
    writeFileSync(join(root, "src/f.ts"), "x\n");
    const h = hooks();
    const a = new Approvals(h.hooks, 60);
    const s1 = await stageChange(items, edit("src/f.ts", "x", "1"));
    const p1 = a.propose("p", s1, { askedBy: "A", readFiles: 0 });
    assert.equal(await a.decide("other", s1.id, true), false);
    await a.decide("p", s1.id, false);
    const r1 = await p1;
    assert.equal(!r1.ok && r1.code, "denied");

    const s2 = await stageChange(items, edit("src/f.ts", "x", "2"));
    const r2 = await a.propose("p", s2, { askedBy: "A", readFiles: 0 }); // 60 ms
    assert.equal(!r2.ok && r2.code, "expired");

    const s3 = await stageChange(items, edit("src/f.ts", "x", "3"));
    const p3 = a.propose("p", s3, { askedBy: "A", readFiles: 0 });
    a.cancel("p", s3.id);
    assert.equal(!(await p3).ok, true);
    assert.equal(readFileSync(join(root, "src/f.ts"), "utf8"), "x\n");
  });

  test("switching AI changes off before the click stops the write", async () => {
    writeFileSync(join(root, "src/g.ts"), "x\n");
    const h = hooks();
    const a = new Approvals(h.hooks);
    const s = await stageChange(items, edit("src/g.ts", "x", "y"));
    const p = a.propose("p", s, { askedBy: "A", readFiles: 0 });
    h.set(false);
    await a.decide("p", s.id, true);
    const r = await p;
    assert.equal(!r.ok && r.code, "disabled");
    assert.equal(readFileSync(join(root, "src/g.ts"), "utf8"), "x\n");
  });

  test("closing a project settles its proposals", async () => {
    writeFileSync(join(root, "src/h.ts"), "x\n");
    const a = new Approvals(hooks().hooks);
    const s = await stageChange(items, edit("src/h.ts", "x", "y"));
    const p = a.propose("p", s, { askedBy: "A", readFiles: 0 });
    a.closeProject("p");
    assert.equal(!(await p).ok, true);
    assert.equal(a.count("p"), 0);
  });
});
