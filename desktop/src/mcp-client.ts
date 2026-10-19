import { cleanOutput, redactSecrets, resultText, toolEntries, type McpCallResult, type ToolEntry } from "@mc/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync } from "node:fs";
import { execEnv } from "./folder-exec.ts";
import { FolderError } from "./folder-fs.ts";

export { resultText, toolEntries, type ToolEntry };

// One MCP tool server, started as a child process on this computer and spoken to over its standard input and output
// (the MCP SDK's stdio transport, as opencode's "local" servers). What a server says is written by someone else: tool
// names are checked, descriptions are cut, results are turned into plain text with terminal control characters and
// secret-shaped text removed, and nothing a server sends is ever run or trusted as an instruction.

export type ServerStatus = "off" | "starting" | "ready" | "failed";

const START_MS = 60_000;
const LIST_MS = 15_000;
const MAX_TOOLS_LISTED = 200;

/** What a server is started with: a trimmed environment (no host tokens), then what the host typed for this server. */
export function serverEnv(userEnv: Record<string, string>, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const base = execEnv(source);
  // execEnv is made for commands; a server doesn't need these.
  for (const k of ["CI", "NO_COLOR", "PAGER", "GIT_PAGER", "GIT_TERMINAL_PROMPT", "GIT_EDITOR", "EDITOR", "TERM"]) delete base[k];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  return { ...out, ...userEnv };
}

export type ServerOptions = {
  command: string[];
  env: Record<string, string>;
  /** Where the server runs: a folder this app owns, so it starts nowhere that matters. */
  cwd: string;
  onChange: () => void;
};

export class McpServerConn {
  status: ServerStatus = "off";
  error: string | undefined;
  tools: ToolEntry[] = [];
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private stopping = false;
  private stderr = "";

  constructor(private readonly o: ServerOptions) {}

  private set(status: ServerStatus, error?: string) {
    this.status = status;
    this.error = error;
    this.o.onChange();
  }

  async start(): Promise<void> {
    if (this.status === "starting" || this.status === "ready") return;
    this.stopping = false;
    this.tools = [];
    this.stderr = "";
    this.set("starting");
    try {
      mkdirSync(this.o.cwd, { recursive: true });
      const [program, ...args] = this.o.command;
      const transport = new StdioClientTransport({ command: program!, args, env: serverEnv(this.o.env), cwd: this.o.cwd, stderr: "pipe" });
      // Keep the last of what the server says about itself, for the host to read if it fails to start.
      transport.stderr?.on("data", (b: Buffer) => {
        this.stderr = (this.stderr + b.toString("utf8")).slice(-1500);
      });
      const client = new Client({ name: "multiuser-chat", version: "0.1.0" }, { capabilities: {} });
      transport.onclose = () => {
        if (this.stopping || this.transport !== transport) return;
        this.client = null;
        this.transport = null;
        this.set("failed", this.reason("The server stopped."));
      };
      transport.onerror = () => undefined; // a broken pipe also closes the transport, which is handled above
      this.transport = transport;
      this.client = client;
      await client.connect(transport, { timeout: START_MS });
      const listed: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: LIST_MS });
        listed.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor && listed.length < MAX_TOOLS_LISTED);
      if (this.stopping) return;
      this.tools = toolEntries(listed);
      this.set("ready");
    } catch (e) {
      if (this.stopping) return;
      const message = e instanceof Error && /timed out|timeout/i.test(e.message) ? "The server did not answer in time." : "The server could not be started or did not speak MCP.";
      await this.teardown();
      this.set("failed", this.reason(message));
    }
  }

  /** The message for the host, with the end of what the server printed (masked), which usually says why. */
  private reason(message: string): string {
    const tail = redactSecrets(cleanOutput(this.stderr)).trim();
    return tail ? `${message}\n${tail.length > 800 ? `${tail.slice(0, 800)}…` : tail}` : message;
  }

  async call(tool: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<McpCallResult> {
    const client = this.client;
    if (!client || this.status !== "ready") throw new FolderError("mcp_unavailable", "That tool server is not running.");
    try {
      return resultText(await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs, signal }));
    } catch (e) {
      if (signal?.aborted) throw new FolderError("expired", "The request was cancelled.");
      // The server's own error text can hold anything; the model gets a fixed sentence and the host's log gets the rest.
      console.error("[mcp] call failed:", e instanceof Error ? e.message : e);
      if (e instanceof Error && /timed out|timeout/i.test(e.message)) throw new FolderError("timeout", "The tool did not answer in time.");
      throw new FolderError("mcp_failed", "The tool server failed to run that tool.");
    }
  }

  private async teardown() {
    const { client, transport } = this;
    this.client = null;
    this.transport = null;
    await (client?.close() ?? transport?.close())?.catch(() => undefined);
  }

  async stop() {
    this.stopping = true;
    await this.teardown();
    this.tools = [];
    this.status = "off";
    this.error = undefined;
    this.o.onChange();
  }
}
