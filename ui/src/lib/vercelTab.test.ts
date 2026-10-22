import assert from "node:assert/strict";
import { test } from "node:test";
import { isVercelMcpUrl, showVercelTab, type VercelLink, type VercelMine } from "@mc/shared";
import { pickedTab, tabShowsName, type FilesTab } from "./filesTabs.ts";

const link: VercelLink = { teamId: "team_i9aKOw3o8vjpcYCLMJowwp0Q", teamSlug: "migw03s-projects", projectId: "prj_zDTfMGC2XAAWBpp2qiN31nW8MKe", name: "multiuser-aichat", linked_by: null, linked_at: "2026-10-22T20:00:00Z" };
const mine = (state: VercelMine["state"]): VercelMine => ({ state });

test("hidden until the state is known", () => {
  assert.equal(showVercelTab(null), false);
});

test("hidden when the project is not linked, whoever the person is", () => {
  for (const s of ["none", "ready", "needs_sign_in", "failed", "connecting", "off"] as const) assert.equal(showVercelTab({ link: null, mine: mine(s) }), false, s);
});

test("hidden when the person has no Vercel set up, even if the project is linked", () => {
  assert.equal(showVercelTab({ link, mine: mine("none") }), false);
});

test("shown when linked and Vercel is set up, in any state", () => {
  for (const s of ["ready", "needs_sign_in", "failed", "connecting", "off"] as const) assert.equal(showVercelTab({ link, mine: mine(s) }), true, s);
});

test("Vercel entries are recognised by host only", () => {
  assert.equal(isVercelMcpUrl("https://mcp.vercel.com/"), true);
  assert.equal(isVercelMcpUrl("https://mcp.vercel.com/migw03s-projects/multiuser-aichat"), true);
  assert.equal(isVercelMcpUrl("https://MCP.VERCEL.COM/mcp"), true);
  assert.equal(isVercelMcpUrl("https://mcp.vercel.com.evil.example/"), false);
  assert.equal(isVercelMcpUrl("https://evil.example/mcp.vercel.com"), false);
  assert.equal(isVercelMcpUrl("http://mcp.vercel.com/"), false);
  assert.equal(isVercelMcpUrl("https://user:pw@mcp.vercel.com/"), false);
  assert.equal(isVercelMcpUrl("not a url"), false);
});

test("with two service tabs only the open one keeps its name; with one, it keeps it", () => {
  const both: FilesTab[] = ["files", "supabase", "vercel"];
  assert.equal(tabShowsName("vercel", "vercel", both), true);
  assert.equal(tabShowsName("supabase", "vercel", both), false);
  assert.equal(tabShowsName("supabase", "files", both), false);
  assert.equal(tabShowsName("files", "vercel", both), true);
  assert.equal(tabShowsName("vercel", "files", ["files", "vercel"]), true);
  assert.equal(tabShowsName("scripts", "vercel", ["files", "scripts", "supabase", "vercel"]), true);
});

test("a saved tab opens only when it is shown", () => {
  assert.equal(pickedTab("vercel", ["files", "vercel"]), "vercel");
  assert.equal(pickedTab("vercel", ["files", "supabase"]), "files");
  assert.equal(pickedTab("nonsense", ["files", "vercel"]), "files");
  assert.equal(pickedTab(undefined, ["files"]), "files");
});
