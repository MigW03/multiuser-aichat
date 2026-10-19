import { MCP_LIMITS as M, type McpCallResult, type McpState } from "@mc/shared";
import { McpServerConn, type ServerStatus } from "./mcp-client.ts";
import { EMPTY_USER, showCommand, validateCommand, validateEnv, validateName, type McpConfig, type McpUserConfig } from "./mcp-config.ts";
import { FolderError } from "./folder-fs.ts";

// A person's connected tools: the saved setup, the tool servers that are running, and the two questions the chat server
// can ask (which tools exist, call this one). The page can read `view` and change the setup through the calls below;
// adding a server needs the person's confirmation in a window the page cannot click (mcp-ipc.ts).
//
// A server runs only while this person is signed in here and the server's own switch is on. The tools are only ever used
// for answers this person asked for (the chat server decides that; see server/src/mcp-relay.ts). Once a server runs,
// its tools are used by the AI without asking each time: the decision is the one made when the server was added.

export type McpToolView = { name: string; description: string; enabled: boolean; usable: boolean; note?: string };
export type McpServerView = { name: string; command: string; envKeys: string[]; enabled: boolean; status: ServerStatus; error?: string; tools: McpToolView[] };
export type McpView = { servers: McpServerView[] };

export type ConfigStore = { load: () => Promise<McpConfig>; save: (config: McpConfig) => Promise<void> };

export class McpHost {
  private config: McpConfig = {};
  private readonly loaded: Promise<void>;
  private readonly conns = new Map<string, McpServerConn>();
  /** The person signed in here right now, or null. Servers of anyone else do not run. */
  private active: string | null = null;
  private readonly starting = new Set<Promise<void>>();
  private inFlight = 0;

  constructor(
    private readonly store: ConfigStore,
    private readonly opts: { cwd: string; onChange: () => void },
  ) {
    this.loaded = store.load().then(
      (c) => void (this.config = c),
      () => undefined,
    );
  }

  private user(userId: string): McpUserConfig {
    return (this.config[userId] ??= EMPTY_USER());
  }

  private key = (userId: string, name: string) => `${userId}\n${name}`;

  private async persist() {
    await this.store.save(this.config);
  }

  /** Starts what should run and stops what should not. Safe to call any time. */
  async sync(): Promise<void> {
    await this.loaded;
    const userId = this.active;
    const u = userId ? this.config[userId] : undefined;
    const wanted = new Set<string>();
    if (userId && u) for (const [name, s] of Object.entries(u.servers)) if (s.enabled) wanted.add(this.key(userId, name));
    for (const [k, conn] of this.conns) {
      if (!wanted.has(k)) {
        void conn.stop();
        this.conns.delete(k);
      }
    }
    for (const k of wanted) {
      if (this.conns.has(k)) continue;
      const name = k.slice(userId!.length + 1);
      const s = u!.servers[name]!;
      const conn = new McpServerConn({ command: s.command, env: s.env, cwd: this.opts.cwd, onChange: this.opts.onChange });
      this.conns.set(k, conn);
      // Starting can take a minute (a first run downloads the server), so nobody waits for it: status changes are reported as they happen.
      const run = conn.start().finally(() => {
        this.starting.delete(run);
        this.opts.onChange();
      });
      this.starting.add(run);
    }
    this.opts.onChange();
  }

  /** Resolves when every server that is starting has either started or failed. */
  async idle() {
    while (this.starting.size) await Promise.all([...this.starting]);
  }

  /** Who is signed in on this computer (null when nobody). Only that person's servers run. */
  async setUser(userId: string | null) {
    this.active = userId;
    await this.sync();
  }

  currentUser = () => this.active;

  async view(userId: string): Promise<McpView> {
    await this.loaded;
    const u = this.config[userId] ?? EMPTY_USER();
    return {
      servers: Object.entries(u.servers).map(([name, s]) => {
        const conn = this.active === userId ? this.conns.get(this.key(userId, name)) : undefined;
        return {
          name,
          command: showCommand(s.command),
          envKeys: Object.keys(s.env),
          enabled: s.enabled,
          status: conn?.status ?? "off",
          ...(conn?.error ? { error: conn.error } : {}),
          tools: (conn?.tools ?? []).map((t) => ({ name: t.name, description: t.description, enabled: !s.disabledTools.includes(t.name), usable: t.usable, ...(t.note ? { note: t.note } : {}) })),
        };
      }),
    };
  }

  /** What the chat server is told: the tools of the signed-in person's running servers that are switched on. */
  state(): McpState {
    const userId = this.active;
    const u = userId ? this.config[userId] : undefined;
    const servers: McpState["servers"] = [];
    if (!userId || !u) return { servers };
    let total = 0;
    for (const [name, s] of Object.entries(u.servers)) {
      const conn = this.conns.get(this.key(userId, name));
      if (!s.enabled || conn?.status !== "ready") continue;
      const tools = conn.tools.filter((t) => t.usable && !s.disabledTools.includes(t.name)).slice(0, Math.max(0, M.tools - total));
      total += tools.length;
      if (tools.length) servers.push({ name, tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    }
    return { servers };
  }

  // ---------------------------------------------------------------- changes the person makes

  /** Adds a server, switched on. The caller has already had the person confirm exactly this command. */
  async add(userId: string, name: unknown, command: unknown, env: unknown) {
    await this.loaded;
    const spec = { command: validateCommand(command), env: validateEnv(env), enabled: true, disabledTools: [] as string[] };
    const n = validateName(name);
    const u = this.user(userId);
    if (u.servers[n]) throw new FolderError("exists", `There is already a server called ${n}.`);
    if (Object.keys(u.servers).length >= M.servers) throw new FolderError("bad_request", `You can have up to ${M.servers} tool servers.`);
    u.servers[n] = spec;
    try {
      await this.persist();
    } catch (e) {
      delete u.servers[n];
      throw e;
    }
    await this.sync();
  }

  async remove(userId: string, name: string) {
    await this.loaded;
    const u = this.config[userId];
    if (!u?.servers[name]) return;
    delete u.servers[name];
    await this.persist();
    await this.sync();
  }

  async setServerEnabled(userId: string, name: string, enabled: boolean) {
    await this.loaded;
    const s = this.config[userId]?.servers[name];
    if (!s) return;
    s.enabled = enabled;
    await this.persist();
    await this.sync();
  }

  async setToolEnabled(userId: string, name: string, tool: string, enabled: boolean) {
    await this.loaded;
    const s = this.config[userId]?.servers[name];
    if (!s || typeof tool !== "string" || tool.length > M.toolNameChars) return;
    s.disabledTools = enabled ? s.disabledTools.filter((t) => t !== tool) : [...new Set([...s.disabledTools, tool])].slice(0, 500);
    await this.persist();
    this.opts.onChange();
  }

  /** Starts a failed server again. */
  async retry(userId: string, name: string) {
    await this.loaded;
    const k = this.key(userId, name);
    const conn = this.conns.get(k);
    if (conn?.status === "failed") {
      await conn.stop();
      this.conns.delete(k);
    }
    await this.sync();
  }

  // ---------------------------------------------------------------- what the chat server asks

  async call(req: { server?: unknown; tool?: unknown; args?: unknown }, signal?: AbortSignal): Promise<McpCallResult> {
    await this.loaded;
    const userId = this.active;
    const name = typeof req.server === "string" ? req.server : "";
    const tool = typeof req.tool === "string" ? req.tool : "";
    const s = userId ? this.config[userId]?.servers[name] : undefined;
    const conn = userId ? this.conns.get(this.key(userId, name)) : undefined;
    const known = conn?.tools.find((t) => t.name === tool && t.usable);
    if (!s || !s.enabled || !conn || conn.status !== "ready" || !known || s.disabledTools.includes(tool)) throw new FolderError("mcp_unavailable", "That tool is not available (the server is off or does not have it).");
    const args = req.args && typeof req.args === "object" && !Array.isArray(req.args) ? (req.args as Record<string, unknown>) : null;
    if (!args || JSON.stringify(args).length > M.argChars) throw new FolderError("bad_request", "The tool's arguments must be an object of reasonable size.");
    if (this.inFlight >= 4) throw new FolderError("busy", "Several tool calls are already running. Try again in a moment.");
    this.inFlight++;
    try {
      return await conn.call(tool, args, M.callDefaultMs, signal);
    } finally {
      this.inFlight--;
    }
  }

  async closeAll() {
    this.active = null;
    await Promise.all([...this.conns.values()].map((c) => c.stop()));
    this.conns.clear();
  }
}
