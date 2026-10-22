import assert from "node:assert/strict";
import { describe, it } from "node:test";
import spec from "@mc/shared/genui-spec.json" with { type: "json" };
import { genUiInstructions } from "./genui.ts";

describe("genUiInstructions", () => {
  it("lists every piece of the app's library", () => {
    for (const name of Object.keys(spec.components)) assert.ok(genUiInstructions.includes(`${name}(`), name);
  });
  it("keeps Markdown answers: no 'whole reply must be openui-lang' rule, and the fence is named", () => {
    assert.doesNotMatch(genUiInstructions, /ENTIRE response must be valid openui-lang/);
    assert.match(genUiInstructions, /```openui-lang/);
  });
  it("offers no data tools to generated UI", () => {
    assert.doesNotMatch(genUiInstructions, /Query\(|Mutation\(|@Run/);
  });
});
