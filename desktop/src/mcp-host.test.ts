import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FolderError } from "./folder-fs.ts";
import { resultText, serverEnv, toolEntries } from "./mcp-client.ts";
import { parseCommandLine, parseConfig, parseEnvText, serializeConfig, showCommand, validateCommand, validateEnv, validateName, type McpConfig, type Vault } from "./mcp-config.ts";
import { McpHost } from "./mcp-host.ts";

const U = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "test-fixtures", "fake-mcp-server.mjs");
const vault: Vault = { available: () => true, encrypt: (t) => `enc:${Buffer.from(t).toString("base64")}`, decrypt: (b) => Buffer.from(b.replace(/^enc:/, ""), "base64").toString() };
const isId = (v: string) => /^[0-9a-f-]{36}$/.test(v);

const fails = async (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof FolderError && e.code === code, `expected ${code}`);

function makeHost() {
  let saved: McpConfig = {};
  let changes = 0;
  const host = new McpHost(
    { load: async () => saved, save: async (c) => void (saved = JSON.parse(JSON.stringify(c))) },
    { cwd: mkdtempSync(join(tmpdir(), "mc-mcp-")), onChange: () => void changes++ },
  );
  return { host, saved: () => saved, changes: () => changes };
}

describe("config rules", () => {
  test("names, commands and environment are checked", () => {
    assert.equal(validateName("files_1"), "files_1");
    for (const bad of ["", "a b", "a/b", "x".repeat(33), 5]) assert.throws(() => validateName(bad), FolderError);
    assert.deepEqual(validateCommand(["npx", "-y", "pkg"]), ["npx", "-y", "pkg"]);
    for (const bad of [[], ["  "], ["a\nb"], ["a\u202eb"], [1], "npx -y", Array(40).fill("a"), ["x".repeat(501)]]) assert.throws(() => validateCommand(bad), FolderError);
    assert.deepEqual(validateEnv({ API_KEY: "k" }), { API_KEY: "k" });
    for (const bad of [{ "1A": "x" }, { "A-B": "x" }, { A: 5 }, { A: "a\u0000b" }, ["x"], Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`K${i}`, "v"]))]) assert.throws(() => validateEnv(bad), FolderError);
    assert.equal(showCommand(["a b", "c"]), '"a b" "c"');
  });

  test("a typed command line is split into parts by quotes, never by a shell", () => {
    assert.deepEqual(parseCommandLine("npx -y @scope/server-files /Users/me/my files"), ["npx", "-y", "@scope/server-files", "/Users/me/my", "files"]);
    assert.deepEqual(parseCommandLine(`node "C:\\Program Files\\s.js" 'a b' ""`), ["node", "C:\\Program Files\\s.js", "a b", ""]);
    assert.deepEqual(parseCommandLine('echo "say \\"hi\\"" $HOME ~ * | cat'), ["echo", 'say "hi"', "$HOME", "~", "*", "|", "cat"]);
    assert.deepEqual(parseCommandLine("  a\n  b  "), ["a", "b"]);
    for (const bad of ["", "   ", 'a "b', "a 'b", 5, null, `a ${"x".repeat(600)}`]) assert.throws(() => parseCommandLine(bad), FolderError);
  });

  test("typed environment lines", () => {
    assert.deepEqual(parseEnvText("A=1\n# comment\n\nB = \"two words\" \r\nC='x'\nD=a=b"), { A: "1", B: "two words", C: "x", D: "a=b" });
    assert.deepEqual(parseEnvText(""), {});
    assert.deepEqual(parseEnvText(undefined), {});
    for (const bad of ["novalue", "=x", "A=1\nA=2", "1A=x", 5]) assert.throws(() => parseEnvText(bad), FolderError);
  });

  test("env values are encrypted on disk and come back; a lost keychain entry drops only the values", () => {
    const cfg: McpConfig = { [U]: { servers: { s: { command: ["x"], env: { TOKEN: "very-secret" }, enabled: true, disabledTools: ["t"] } } } };
    const text = serializeConfig(cfg, vault);
    assert.ok(!text.includes("very-secret"));
    assert.deepEqual(parseConfig(text, vault, isId), cfg);
    const lost = parseConfig(text, { ...vault, decrypt: () => { throw new Error("no key"); } }, isId);
    assert.deepEqual(lost[U]!.servers.s!.env, {});
    assert.deepEqual(lost[U]!.servers.s!.command, ["x"]);
  });

  test("no keychain: servers with secrets can't be saved, plain ones can", () => {
    const no: Vault = { ...vault, available: () => false };
    assert.throws(() => serializeConfig({ [U]: { servers: { s: { command: ["x"], env: { A: "b" }, enabled: true, disabledTools: [] } } } }, no), FolderError);
    assert.ok(serializeConfig({ [U]: { servers: { s: { command: ["x"], env: {}, enabled: true, disabledTools: [] } } } }, no));
  });

  test("a damaged file or entry is dropped, not trusted", () => {
    assert.deepEqual(parseConfig("not json", vault, isId), {});
    const out = parseConfig(JSON.stringify({ version: 2, users: { [U]: { servers: { ok: { command: ["x"] }, "bad name": { command: ["x"] }, nocmd: {}, evil: { command: ["a\nb"] } } }, "not-an-id": { servers: {} } } }), vault, isId);
    assert.deepEqual(Object.keys(out), [U]);
    assert.deepEqual(Object.keys(out[U]!.servers), ["ok"]);
    // The earlier per-project file format is not carried over to anybody.
    assert.deepEqual(parseConfig(JSON.stringify({ version: 1, projects: { [U]: { enabled: true, servers: { s: { command: ["x"] } } } } }), vault, isId), {});
  });
});

describe("what comes from a server is cleaned", () => {
  test("results become plain text without binary data, control characters or secrets", () => {
    const token = ["sk", "ant", "api03", "x".repeat(40)].join("-");
    const r = resultText({ content: [{ type: "text", text: `\u001b[31mred\u001b[0m ${token}` }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "resource", resource: { uri: "file:///a", blob: "AAAA" } }] });
    assert.ok(r.text.includes("red") && !r.text.includes("\u001b") && !r.text.includes(token) && r.text.includes("[image omitted: image/png]") && r.text.includes("[binary resource omitted: file:///a]"));
    assert.equal(r.isError, false);
    assert.equal(resultText({ isError: true, content: [{ type: "text", text: "bad" }] }).isError, true);
    assert.equal(resultText({ structuredContent: { a: 1 } }).text, '{\n  "a": 1\n}');
    const big = resultText({ content: [{ type: "text", text: "y".repeat(80_000) }] });
    assert.equal(big.text.length, 50_000);
    assert.equal(big.truncated, true);
    assert.equal(resultText(null).text, "");
  });

  test("tools with odd names or huge schemas are listed but not usable; descriptions are cut to one line", () => {
    const list = toolEntries([
      { name: "ok", description: "a\nb", inputSchema: { type: "object", properties: {} } },
      { name: "bad name!", description: "", inputSchema: { type: "object" } },
      { name: "huge", description: "", inputSchema: { type: "object", properties: { x: { description: "z".repeat(9000) } } } },
      { name: "ok", description: "duplicate", inputSchema: { type: "object" } },
      { name: "noschema", description: "" },
      { description: "no name" },
      "junk",
    ]);
    assert.deepEqual(list.map((t) => [t.name, t.usable]), [["ok", true], ["bad name!", false], ["huge", false], ["noschema", false]]);
    assert.equal(list[0]!.description, "a b");
  });

  test("the server's environment has no host tokens", () => {
    const env = serverEnv({ MY_KEY: "v" }, { PATH: "/usr/bin", HOME: "/h", GITHUB_TOKEN: "t", OPENAI_API_KEY: "o", SSH_AUTH_SOCK: "/s", LANG: "C" });
    assert.equal(env.MY_KEY, "v");
    assert.ok(env.PATH && env.HOME === "/h");
    for (const k of ["GITHUB_TOKEN", "OPENAI_API_KEY", "SSH_AUTH_SOCK", "CI", "EDITOR"]) assert.equal(env[k], undefined, k);
  });
});

describe("a real tool server over stdio", () => {
  const hosts: McpHost[] = [];
  after(() => Promise.all(hosts.map((h) => h.closeAll())));
  const setup = async (extra: string[] = [], env: Record<string, string> = {}) => {
    const m = makeHost();
    hosts.push(m.host);
    await m.host.add(U, "fake", [process.execPath, FAKE, ...extra], env);
    await m.host.setUser(U);
    await m.host.idle();
    return m;
  };

  test("nothing starts until the person is signed in here; signing out stops it", async () => {
    const m = makeHost();
    hosts.push(m.host);
    await m.host.add(U, "fake", [process.execPath, FAKE], {});
    assert.equal((await m.host.view(U)).servers[0]!.status, "off");
    assert.deepEqual(m.host.state(), { servers: [] });
    await fails(m.host.call({ server: "fake", tool: "echo", args: { text: "hi" } }), "mcp_unavailable");
    await m.host.setUser(U);
    await m.host.idle();
    assert.equal((await m.host.view(U)).servers[0]!.status, "ready");
    await m.host.setUser(null);
    assert.equal((await m.host.view(U)).servers[0]!.status, "off");
    assert.deepEqual(m.host.state(), { servers: [] });
  });

  test("someone else signed in on the same computer never gets another person's servers", async () => {
    const { host } = await setup();
    assert.equal(host.state().servers.length, 1);
    await host.setUser(U2);
    await host.idle();
    assert.deepEqual(host.state(), { servers: [] });
    assert.deepEqual((await host.view(U2)).servers, []);
    await fails(host.call({ server: "fake", tool: "echo", args: { text: "x" } }), "mcp_unavailable");
    assert.equal((await host.view(U)).servers[0]!.status, "off"); // not running for the other person
    await host.setUser(U);
    await host.idle();
    assert.equal(host.state().servers.length, 1);
  });

  test("lists tools and calls them", async () => {
    const { host } = await setup();
    const view = (await host.view(U)).servers[0]!;
    assert.deepEqual(view.tools.map((t) => t.name).sort(), ["big", "boom", "echo", "env", "image", "slow"]);
    assert.equal(view.tools.find((t) => t.name === "echo")!.description, "Echo text back. Second line.");
    const state = host.state();
    assert.deepEqual(state.servers[0]!.tools.find((t) => t.name === "echo")!.inputSchema.required, ["text"]);
    const r = await host.call({ server: "fake", tool: "echo", args: { text: "hi" } });
    assert.deepEqual(r, { text: "echo: hi", isError: false, truncated: false });
    assert.equal((await host.call({ server: "fake", tool: "boom", args: {} })).isError, true);
    const img = await host.call({ server: "fake", tool: "image", args: {} });
    assert.ok(img.text.includes("[image omitted: image/png]") && img.text.includes("red") && !img.text.includes("\u001b"));
    const big = await host.call({ server: "fake", tool: "big", args: {} });
    assert.equal(big.truncated, true);
    assert.equal(big.text.length, 50_000);
  });

  test("the server sees the person's typed environment but not the computer's own tokens", async () => {
    process.env.MC_TEST_HOST_TOKEN = "nope";
    const { host } = await setup([], { TYPED_KEY: "yes" });
    const names = (await host.call({ server: "fake", tool: "env", args: {} })).text.split(",");
    assert.ok(names.includes("TYPED_KEY"));
    assert.ok(!names.includes("MC_TEST_HOST_TOKEN"));
    delete process.env.MC_TEST_HOST_TOKEN;
  });

  test("unknown, switched-off and malformed calls are refused", async () => {
    const { host } = await setup();
    await fails(host.call({ server: "nope", tool: "echo", args: {} }), "mcp_unavailable");
    await fails(host.call({ server: "fake", tool: "nope", args: {} }), "mcp_unavailable");
    await fails(host.call({ server: "fake", tool: "echo", args: "text" }), "bad_request");
    await fails(host.call({ server: "fake", tool: "echo", args: { text: "x".repeat(100_001) } }), "bad_request");
    await host.setToolEnabled(U, "fake", "echo", false);
    await fails(host.call({ server: "fake", tool: "echo", args: { text: "x" } }), "mcp_unavailable");
    assert.ok(!host.state().servers[0]!.tools.some((t) => t.name === "echo"));
    await host.setToolEnabled(U, "fake", "echo", true);
    assert.equal((await host.call({ server: "fake", tool: "echo", args: { text: "x" } })).text, "echo: x");
    await host.setServerEnabled(U, "fake", false);
    await fails(host.call({ server: "fake", tool: "echo", args: { text: "x" } }), "mcp_unavailable");
    assert.deepEqual(host.state(), { servers: [] });
    await host.setServerEnabled(U, "fake", true);
    await host.idle();
    assert.equal((await host.call({ server: "fake", tool: "echo", args: { text: "back" } })).text, "echo: back");
  });

  test("a server that can't start is reported with a plain message and can be retried", async () => {
    const m = makeHost();
    hosts.push(m.host);
    await m.host.add(U, "broken", ["/definitely/not/a/program"], {});
    await m.host.setUser(U);
    await m.host.idle();
    const v = (await m.host.view(U)).servers[0]!;
    assert.equal(v.status, "failed");
    assert.match(v.error ?? "", /could not be started/);
    assert.deepEqual(m.host.state(), { servers: [] });
    await m.host.retry(U, "broken");
    await m.host.idle();
    assert.equal((await m.host.view(U)).servers[0]!.status, "failed");
  });

  test("a server that dies later is reported as failed and its tools are withdrawn", async () => {
    const { host } = await setup(["--exit-soon"]);
    for (let i = 0; i < 100 && (await host.view(U)).servers[0]!.status === "ready"; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal((await host.view(U)).servers[0]!.status, "failed");
    assert.deepEqual(host.state().servers, []);
    await fails(host.call({ server: "fake", tool: "echo", args: { text: "x" } }), "mcp_unavailable");
  });

  test("a call can be cancelled", async () => {
    const { host } = await setup();
    const c = new AbortController();
    const p = host.call({ server: "fake", tool: "slow", args: {} }, c.signal);
    setTimeout(() => c.abort(), 100);
    await fails(p, "expired");
  });

  test("duplicate names, too many servers and removal", async () => {
    const m = makeHost();
    hosts.push(m.host);
    await m.host.add(U, "a", ["x"], {});
    await fails(m.host.add(U, "a", ["x"], {}), "exists");
    for (let i = 0; i < 9; i++) await m.host.add(U, `s${i}`, ["x"], {});
    await fails(m.host.add(U, "extra", ["x"], {}), "bad_request");
    await m.host.remove(U, "a");
    assert.equal((await m.host.view(U)).servers.length, 9);
    assert.equal(Object.keys(m.saved()[U]!.servers).length, 9);
  });
});
