// A tiny MCP server over stdio, for tests: tools echo, big, boom, image, slow.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake", version: "1.0.0" });
server.registerTool("echo", { description: "Echo text back.\nSecond line.", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }));
server.registerTool("env", { description: "Names of the environment variables it can see." }, async () => ({ content: [{ type: "text", text: Object.keys(process.env).sort().join(",") }] }));
server.registerTool("big", { description: "A very long answer." }, async () => ({ content: [{ type: "text", text: "x".repeat(80_000) }] }));
server.registerTool("boom", { description: "Always fails." }, async () => ({ isError: true, content: [{ type: "text", text: "it broke" }] }));
server.registerTool("image", { description: "Returns an image." }, async () => ({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "\u001b[31mred\u001b[0m" }] }));
server.registerTool("slow", { description: "Never answers in time." }, async () => { await new Promise((r) => setTimeout(r, 30_000)); return { content: [] }; });
if (process.argv.includes("--exit-soon")) setTimeout(() => process.exit(3), 300);
await server.connect(new StdioServerTransport());
