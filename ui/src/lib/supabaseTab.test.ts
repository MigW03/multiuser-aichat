import assert from "node:assert/strict";
import { test } from "node:test";
import { isSupabaseMcpUrl, showSupabaseTab, type SupabaseMine, type SupabaseLink } from "@mc/shared";

const link: SupabaseLink = { ref: "abcdefghijklmnopqrst", name: "muti user chat", region: "sa-east-1", linked_by: null, linked_at: "2026-10-22T20:00:00Z" };
const mine = (state: SupabaseMine["state"]): SupabaseMine => ({ state });

test("hidden until the state is known", () => {
  assert.equal(showSupabaseTab(null), false);
});

test("hidden when the project is not linked, whoever the person is", () => {
  for (const s of ["none", "ready", "needs_sign_in", "failed", "connecting", "off"] as const) assert.equal(showSupabaseTab({ link: null, mine: mine(s) }), false, s);
});

test("hidden when the person has no Supabase set up, even if the project is linked", () => {
  assert.equal(showSupabaseTab({ link, mine: mine("none") }), false);
});

test("shown when linked and Supabase is set up, in any state (signed out, off, failed show their own message)", () => {
  for (const s of ["ready", "needs_sign_in", "failed", "connecting", "off"] as const) assert.equal(showSupabaseTab({ link, mine: mine(s) }), true, s);
});

test("Supabase entries are recognised by host only", () => {
  assert.equal(isSupabaseMcpUrl("https://mcp.supabase.com/mcp"), true);
  assert.equal(isSupabaseMcpUrl("https://mcp.supabase.com/mcp?read_only=true&project_ref=abc"), true);
  assert.equal(isSupabaseMcpUrl("https://MCP.SUPABASE.COM/mcp"), true);
  assert.equal(isSupabaseMcpUrl("https://mcp.supabase.com.evil.example/mcp"), false);
  assert.equal(isSupabaseMcpUrl("https://evil.example/mcp.supabase.com"), false);
  assert.equal(isSupabaseMcpUrl("http://mcp.supabase.com/mcp"), false);
  assert.equal(isSupabaseMcpUrl("https://user:pw@mcp.supabase.com/mcp"), false);
  assert.equal(isSupabaseMcpUrl("not a url"), false);
});
