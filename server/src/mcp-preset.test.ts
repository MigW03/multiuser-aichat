import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mcpPresetFor, VERCEL_PRESET_TOOLS } from "@mc/shared";
import { toolOffered } from "./mcp-remote.ts";

const row = (url: string, extra: { disabled_tools?: string[]; all_tools?: boolean } = {}) => ({ url, disabled_tools: [] as string[], ...extra });
const VERCEL = "https://mcp.vercel.com/";

describe("tool presets", () => {
  test("Vercel: only the 12 picked tools reach the AI (11 to look, 1 for the docs)", () => {
    assert.equal(VERCEL_PRESET_TOOLS.length, 12);
    for (const t of VERCEL_PRESET_TOOLS) assert.equal(toolOffered(row(VERCEL), t), true, t);
    for (const t of ["create_deployment", "request_promote", "request_rollback", "add_project_domain", "update_project", "create_project_env", "edit_project_env", "buy_domain", "create_record", "replace_domain_dns_records", "update_firewall_config", "pause_project", "create_drain", "run_session_command", "create_sdk_key"]) assert.equal(toolOffered(row(VERCEL), t), false, t);
  });
  test("the switch 'All tools' offers everything the server lists", () => {
    assert.equal(toolOffered(row(VERCEL, { all_tools: true }), "buy_domain"), true);
  });
  test("a tool the person switched off stays off, preset or not", () => {
    assert.equal(toolOffered(row(VERCEL, { disabled_tools: ["get_project"] }), "get_project"), false);
    assert.equal(toolOffered(row(VERCEL, { all_tools: true, disabled_tools: ["buy_domain"] }), "buy_domain"), false);
  });
  test("a server without a preset offers everything, as before", () => {
    assert.equal(mcpPresetFor("https://mcp.supabase.com/mcp?read_only=true"), null);
    assert.equal(toolOffered(row("https://example.com/mcp"), "anything"), true);
    assert.equal(toolOffered(row("https://example.com/mcp", { disabled_tools: ["x"] }), "x"), false);
  });
  test("the preset is picked by host only", () => {
    assert.notEqual(mcpPresetFor("https://MCP.VERCEL.COM/mcp"), null);
    assert.equal(mcpPresetFor("https://mcp.vercel.com.evil.example/"), null);
    assert.equal(mcpPresetFor("https://evil.example/mcp.vercel.com"), null);
    assert.equal(mcpPresetFor("http://mcp.vercel.com/"), null);
  });
});
