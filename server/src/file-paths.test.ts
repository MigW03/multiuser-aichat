import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { downloadName, objectKey, PathError, projectPrefix, relativeTo, sharePrefix, splitStoredPath } from "./file-paths.ts";

const P = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("splitStoredPath", () => {
  test("accepts ordinary paths", () => {
    assert.deepEqual(splitStoredPath("src/index.ts"), ["src", "index.ts"]);
    assert.deepEqual(splitStoredPath("README.md"), ["README.md"]);
    assert.deepEqual(splitStoredPath("notes/my file (1).txt"), ["notes", "my file (1).txt"]);
    assert.deepEqual(splitStoredPath("", { allowRoot: true }), []);
  });

  test("refuses what could leave the item or pose as another name", () => {
    const bad = [
      "", "/etc/passwd", "a/", "../x", "a/../b", "a/./b", "a//b", ".", "..", "a\\b", "C:/x", "a:b", "x\u0000y", "x\ny", "a\u202eb", "a\u200bb",
      "con", "NUL.txt", "name.", "name ", "a/b/".padEnd(401, "c"), Array(31).fill("d").join("/"), "x".repeat(256),
    ];
    for (const p of bad) assert.throws(() => splitStoredPath(p), PathError, JSON.stringify(p));
    for (const p of [undefined, null, 5, {}]) assert.throws(() => splitStoredPath(p), PathError);
  });

  test("refuses secrets and junk the desktop app never shares", () => {
    for (const p of [".env", "app/.env.local", ".git/config", "node_modules/x/index.js", "a/id_rsa", "keys/server.pem", ".ssh/known_hosts", ".ENV.", "dist/app.js"]) {
      assert.throws(() => splitStoredPath(p), PathError, p);
    }
    // a last segment named like a hidden folder is only hidden when it is a folder
    assert.deepEqual(splitStoredPath("docs/build"), ["docs", "build"]);
    assert.throws(() => splitStoredPath("docs/build", { isDir: true }), PathError);
  });
});

describe("keys", () => {
  test("are built from checked ids and parts", () => {
    assert.equal(projectPrefix(P.toUpperCase()), `projects/${P}/`);
    assert.equal(sharePrefix(P, S), `projects/${P}/${S}/`);
    assert.equal(objectKey(P, S, ["a", "b.txt"]), `projects/${P}/${S}/a/b.txt`);
    assert.equal(relativeTo(`projects/${P}/${S}/a/`, `projects/${P}/${S}/a/b.txt`), "b.txt");
  });

  test("refuse ids that are not UUIDs, and empty paths", () => {
    assert.throws(() => projectPrefix("../other"), PathError);
    assert.throws(() => sharePrefix(P, `${S}/..`), PathError);
    assert.throws(() => sharePrefix("*", S), PathError);
    assert.throws(() => objectKey(P, S, []), PathError);
  });

  test("download names are safe in a header", () => {
    assert.equal(downloadName(["a", 'b"c\\d\ne.txt']), "b_c_d_e.txt");
  });
});
