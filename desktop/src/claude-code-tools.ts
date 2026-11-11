import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME } from "./claude-code-run.ts";

/**
 * The in-process tool server `claude` is given for one step. It only lists the step's tools (names, descriptions, JSON
 * schemas, all from the chat server) so the AI can ask for them. Calling one does nothing here: `claude` is stopped
 * the moment the AI has asked (claude-code-run.ts), and the chat server is the one that runs the tool.
 */
export function makeToolServer(tools: { name: string; description: string; inputSchema: Record<string, unknown> }[]) {
  const mcp = new McpServer({ name: SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: { ...t.inputSchema, type: "object" as const } })),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async () => ({ isError: true, content: [{ type: "text" as const, text: "Tools are run by Nido, not here." }] }));
  return { type: "sdk" as const, name: SERVER_NAME, instance: mcp };
}
