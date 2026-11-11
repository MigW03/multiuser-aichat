import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { candidatePaths, claudeEnv, findClaude, isClaudeVersion, loginState, verifyClaude } from "./claude-code-bin.ts";

const exec = (code: number, stdout: string) => async () => ({ code, stdout });

describe("is it the real claude", () => {
  test("only Claude Code's own version line counts", () => {
    assert.equal(isClaudeVersion("2.1.322 (Claude Code)\n"), true);
    assert.equal(isClaudeVersion("Python 3.13"), false);
    assert.equal(isClaudeVersion("2.1.322"), false);
    assert.equal(isClaudeVersion("rm -rf / (Claude Code) extra"), false);
  });
  test("a relative path, a missing file and a non-executable file are refused without running anything", async () => {
    let ran = 0;
    const ex = async () => (ran++, { code: 0, stdout: "2.1.322 (Claude Code)" });
    assert.equal(await verifyClaude("claude", ex), false);
    assert.equal(await verifyClaude("/no/such/claude", ex), false);
    const dir = await mkdtemp(join(tmpdir(), "cc-bin-"));
    const f = join(dir, "claude");
    await writeFile(f, "#!/bin/sh\n");
    await chmod(f, 0o644);
    if (process.platform !== "win32") assert.equal(await verifyClaude(f, ex), false);
    assert.equal(ran, 0);
    await chmod(f, 0o755);
    assert.equal(await verifyClaude(f, ex), true);
    assert.equal(await verifyClaude(f, exec(0, "other tool 1.0")), false);
  });
  test("a chosen program that is not claude means nothing is found, instead of falling back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-bin-"));
    const f = join(dir, "claude");
    await writeFile(f, "#!/bin/sh\n");
    await chmod(f, 0o755);
    assert.equal(await findClaude(f, exec(0, "nope")), null);
    assert.equal(await findClaude(f, exec(0, "2.1.322 (Claude Code)")), f);
  });
  test("candidates cover the PATH and the usual install places, once each", () => {
    const c = candidatePaths({ PATH: "/a/bin:/a/bin:relative" }, "/home/me");
    assert.ok(c.includes("/a/bin/claude"));
    assert.ok(!c.some((p) => p.startsWith("relative")));
    assert.ok(c.includes("/home/me/.local/bin/claude"));
    assert.equal(new Set(c).size, c.length);
  });
});

describe("the environment claude gets", () => {
  test("no API key, token or provider switch passes; its own config folder and the network settings do", () => {
    const env = claudeEnv({ PATH: "/usr/bin", HOME: "/h", ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o", CLAUDE_CODE_USE_BEDROCK: "1", AWS_SECRET_ACCESS_KEY: "s", GITHUB_TOKEN: "g", CLAUDE_CONFIG_DIR: "/h/.cfg", HTTPS_PROXY: "http://p" });
    assert.deepEqual(Object.keys(env).filter((k) => /ANTHROPIC|TOKEN|SECRET|BEDROCK|OAUTH/.test(k)), []);
    assert.equal(env.CLAUDE_CONFIG_DIR, "/h/.cfg");
    assert.equal(env.HTTPS_PROXY, "http://p");
    assert.equal(env.HOME, "/h");
  });
});

describe("sign-in status", () => {
  test("signed in shows the account line only", async () => {
    const r = await loginState("/c", exec(0, JSON.stringify({ loggedIn: true, email: "me@example.com", subscriptionType: "max", accessToken: "SECRET" })));
    assert.deepEqual(r, { login: "signed_in", account: "me@example.com · max" });
    assert.ok(!JSON.stringify(r).includes("SECRET"));
  });
  test("signed out, and not understood", async () => {
    assert.equal((await loginState("/c", exec(1, JSON.stringify({ loggedIn: false })))).login, "signed_out");
    assert.equal((await loginState("/c", exec(1, "Not logged in"))).login, "signed_out");
    assert.equal((await loginState("/c", exec(1, "weird"))).login, "unknown");
    assert.equal((await loginState("/c", exec(0, "not json"))).login, "unknown");
  });
  test("control characters and long values are cleaned from the label", async () => {
    const r = await loginState("/c", exec(0, JSON.stringify({ loggedIn: true, email: `a\u001b[31mb${"x".repeat(200)}` })));
    assert.ok(r.account && r.account.length <= 80 && !/\u001b/.test(r.account));
  });
});
