import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { safeToErase } from "./erase-data.ts";

const posix = process.platform !== "win32";

describe("which folder may be erased", () => {
  test("a folder strictly inside the application-data folder", { skip: !posix }, () => {
    assert.equal(safeToErase("/Users/ana/Library/Application Support/Multiuser Chat", "/Users/ana/Library/Application Support"), true);
    assert.equal(safeToErase("/home/ana/.config/Multiuser Chat/", "/home/ana/.config"), true);
  });
  test("never the application-data folder itself, anything above it, or the home folder", { skip: !posix }, () => {
    const appData = "/Users/ana/Library/Application Support";
    for (const bad of [appData, `${appData}/`, "/Users/ana/Library", "/Users/ana", "/Users", "/", "/Users/ana/Documents", "/tmp"]) assert.equal(safeToErase(bad, appData), false, bad);
  });
  test("a path that only looks like it is inside is not", { skip: !posix }, () => {
    const appData = "/Users/ana/Library/Application Support";
    assert.equal(safeToErase(`${appData}-evil/Multiuser Chat`, appData), false);
    assert.equal(safeToErase(`${appData}/../Documents`, appData), false);
    assert.equal(safeToErase(`${appData}/Nido/../../..`, appData), false);
  });
  test("relative, empty or odd input is refused", () => {
    for (const bad of ["", "Multiuser Chat", "./x", "../x", null, undefined, 5]) assert.equal(safeToErase(bad as never, "/Users/ana/Library/Application Support"), false);
    assert.equal(safeToErase("/Users/ana/x", "" as never), false);
    assert.equal(safeToErase("/a/b", "/"), false);
  });
});
