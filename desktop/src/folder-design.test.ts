import { emptyDesign } from "@mc/shared";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { designRead } from "./folder-design.ts";
import { FolderError } from "./folder-fs.ts";
import { nameItems, type Item } from "./folder-items.ts";

const fails = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof FolderError && e.code === code, `expected ${code}`);
};

let root = "";
let items: Item[] = [];
const at = (path: string) => `${items[0]!.name}/${path}`;

before(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mc-design-")));
  root = join(base, "app");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "designs"), { recursive: true });
  writeFileSync(join(root, "src/page.tsx"), "export {};\n");
  writeFileSync(join(root, "designs/landing.design.html"), emptyDesign());
  mkdirSync(join(base, "outside"));
  writeFileSync(join(base, "outside/x.design.html"), emptyDesign());
  symlinkSync(join(base, "outside"), join(root, "linked"));
  items = nameItems([{ abs: root, kind: "dir" }]);
});

describe("older design files on the host", () => {
  test("are read whole", async () => {
    const r = await designRead(items, { path: at("designs/landing.design.html") });
    assert.equal(r.path, at("designs/landing.design.html"));
    assert.equal(r.text, emptyDesign());
  });

  test("only design files, inside the shared folder, without links", async () => {
    await fails(designRead(items, { path: at("src/page.tsx") }), "bad_request");
    await assert.rejects(designRead(items, { path: "../x.design.html" }), FolderError);
    await fails(designRead(items, { path: at("linked/x.design.html") }), "excluded");
    await fails(designRead(items, { path: at("designs/none.design.html") }), "not_found");
  });
});
