import { CLAUDE_CODE_LIMITS as CC, isClaudeCodeModel, type ClaudeCodeUsage, type ClaudeCodeEffort, type ClaudeCodeEvent, type ClaudeCodeReport, type ClaudeCodeRequest, type ClaudeCodeStatus } from "@mc/shared";
import { homedir } from "node:os";
import { claudeEnv, findClaude, loginState, type LoginState } from "./claude-code-bin.ts";
import { askPlanUsage, runStep, StepError, type QueryFn, type StepDeps } from "./claude-code-run.ts";
import { UsageTracker } from "./claude-code-usage.ts";

// The person's own Claude Code login, as far as this app is concerned: whether it is switched on, which `claude` program
// it would run, and whether that program says it is signed in. Switched OFF by default, per person on this computer. The
// app never reads, stores or copies a credential: `claude` keeps its own sign-in, and the person made it themselves
// with `claude auth login` in a terminal.

export type ClaudeCodeSetting = { enabled: boolean; /** A `claude` the person chose themselves (absolute path), instead of the one found. */ binary?: string };
export type ClaudeCodeConfig = Record<string, ClaudeCodeSetting>;
export type ClaudeCodeStore = { load: () => Promise<ClaudeCodeConfig>; save: (config: ClaudeCodeConfig) => Promise<void> };

/** Parses the saved file; anything that does not look right is dropped. */
export function parseClaudeCodeConfig(text: string, isUserId: (v: unknown) => boolean): ClaudeCodeConfig {
  const out: ClaudeCodeConfig = {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [user, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isUserId(user) || !v || typeof v !== "object") continue;
    const s = v as { enabled?: unknown; binary?: unknown };
    out[user] = { enabled: s.enabled === true, ...(typeof s.binary === "string" && s.binary.length > 0 && s.binary.length < 1024 ? { binary: s.binary } : {}) };
  }
  return out;
}

const shorten = (path: string | null): string | null => {
  if (!path) return null;
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};

const MAX_RUNS = 3;

export type ClaudeCodeHostDeps = {
  store: ClaudeCodeStore;
  /** An empty folder `claude` runs in, so it starts nowhere that matters. */
  workDir: () => Promise<string>;
  /** The Agent SDK's `query` and the builder for the step's tool list (injected so tests need no real `claude`). */
  query: () => Promise<QueryFn>;
  makeTools: StepDeps["makeTools"];
  /** Whether the Agent SDK is part of this build of the app. */
  available?: () => Promise<boolean>;
  find?: typeof findClaude;
  login?: typeof loginState;
  onChange: () => void;
};

export class ClaudeCodeHost {
  private config: ClaudeCodeConfig = {};
  private readonly loaded: Promise<void>;
  private active: string | null = null;
  private bin: string | null = null;
  private login: LoginState = { login: "unknown", account: null };
  private error: string | null = null;
  private checking: Promise<void> | null = null;
  private runs = 0;
  private readonly usage = new UsageTracker();
  private usageAsk: Promise<void> | null = null;
  private usageAskedAt = 0;
  /** Told after every change (the connection to the chat server reports `report()` again). */
  readonly listeners = new Set<() => void>();
  private notify() {
    this.d.onChange();
    for (const l of this.listeners) l();
  }
  /** The connection to the chat server, for the status line. */
  getLink: () => ClaudeCodeStatus["link"] = () => "off";

  constructor(private readonly d: ClaudeCodeHostDeps) {
    this.loaded = d.store.load().then(
      (c) => void (this.config = c),
      () => undefined,
    );
  }

  currentUser = () => this.active;

  private setting(userId: string): ClaudeCodeSetting {
    return this.config[userId] ?? { enabled: false };
  }

  /** Who is signed in on this computer. Only that person's setting counts. */
  async setUser(userId: string | null) {
    await this.loaded;
    if (this.active === userId) return;
    this.active = userId;
    this.usage.clear();
    this.bin = null;
    this.login = { login: "unknown", account: null };
    this.error = null;
    if (userId && this.setting(userId).enabled) await this.refresh();
    this.notify();
  }

  /** Finds `claude` and asks it whether it is signed in. Only does that while the person has it switched on. */
  refresh(): Promise<void> {
    this.checking ??= this.check().finally(() => {
      this.checking = null;
      this.notify();
    });
    return this.checking;
  }

  private async check() {
    await this.loaded;
    const userId = this.active;
    if (!userId) return;
    const custom = this.setting(userId).binary ?? null;
    try {
      if (this.d.available && !(await this.d.available())) {
        this.bin = null;
        this.error = "This build of the app does not include the Claude Code SDK.";
        return;
      }
      this.bin = await (this.d.find ?? findClaude)(custom);
      if (!this.bin) {
        this.login = { login: "unknown", account: null };
        this.error = custom ? "The program you chose is not Claude Code any more." : "Claude Code was not found on this computer.";
        return;
      }
      this.login = await (this.d.login ?? loginState)(this.bin);
      this.error = this.login.login === "signed_out" ? "Claude Code is not signed in." : null;
      // Once it is switched on and signed in (app start, sign-in, switching on), the person's usage is fetched by itself: nobody has to press Refresh.
      this.startUsageAsk();
    } catch {
      this.error = "Could not check Claude Code.";
    }
  }

  /** Whether this build of the app has the Agent SDK at all (a packaged release does not). */
  sdkAvailable = async (): Promise<boolean> => !this.d.available || (await this.d.available());

  /** Where `claude` is, without switching anything on (the confirm window names it before the person agrees). */
  async detect(userId: string): Promise<string | null> {
    await this.loaded;
    if (this.d.available && !(await this.d.available())) return null;
    return (this.d.find ?? findClaude)(this.setting(userId).binary ?? null);
  }

  async status(): Promise<ClaudeCodeStatus> {
    await this.loaded;
    const s = this.active ? this.setting(this.active) : { enabled: false };
    return { enabled: s.enabled, binary: shorten(this.bin), custom: !!(s as ClaudeCodeSetting).binary, login: this.login.login, account: this.login.account, error: this.error, link: this.getLink() };
  }

  /** What the chat server is told: the AI may use this person's login now. Never true unless they switched it on. */
  report(): ClaudeCodeReport {
    const s = this.active ? this.config[this.active] : undefined;
    return { ready: !!s?.enabled && !!this.bin && this.login.login !== "signed_out" };
  }

  /** The caller has already had the person confirm in a window the page cannot click. */
  async setEnabled(userId: string, enabled: boolean) {
    await this.loaded;
    const prev = this.config[userId];
    this.config[userId] = { ...this.setting(userId), enabled };
    try {
      await this.d.store.save(this.config);
    } catch (e) {
      if (prev) this.config[userId] = prev;
      else delete this.config[userId];
      throw e;
    }
    if (this.active === userId) {
      if (enabled) await this.refresh();
      else {
        this.bin = null;
        this.usage.clear();
        this.login = { login: "unknown", account: null };
        this.error = null;
      }
    }
    this.notify();
  }

  /** `binary` is a path the caller has already verified is Claude Code, or null to go back to the usual places. */
  async setBinary(userId: string, binary: string | null) {
    await this.loaded;
    const s = this.setting(userId);
    const { binary: _old, ...rest } = s;
    void _old;
    this.config[userId] = { ...rest, ...(binary ? { binary } : {}) };
    await this.d.store.save(this.config);
    if (this.active === userId && s.enabled) await this.refresh();
    this.notify();
  }

  /**
   * The person's plan limits as `claude` last said them. With `refresh`, `claude` is asked directly first (at most every 30 s, one
   * question at a time); an answer that does not come leaves what the answers reported. null: nothing known (not switched on, an
   * API-key login, or nothing reported yet).
   */
  async getUsage(refresh: boolean): Promise<ClaudeCodeUsage | null> {
    await this.loaded;
    if (!this.report().ready || !this.bin) return null;
    if (refresh) this.startUsageAsk();
    if (this.usageAsk) await this.usageAsk;
    return this.usage.snapshot();
  }

  /** Asks `claude` for the plan limits in the background: only while it is switched on and ready, at most every 30 s, one at a time. */
  private startUsageAsk() {
    if (!this.report().ready || !this.bin || Date.now() - this.usageAskedAt <= 30_000) return;
    this.usageAskedAt = Date.now();
    this.usageAsk ??= this.askUsage().finally(() => {
      this.usageAsk = null;
    });
  }

  private async askUsage() {
    const bin = this.bin;
    const userId = this.active;
    if (!bin || !userId) return;
    try {
      const answer = await askPlanUsage({ query: await this.d.query(), bin, cwd: await this.d.workDir(), env: claudeEnv() }, new AbortController().signal);
      if (this.active === userId && this.usage.applyUsage(answer)) this.notify();
    } catch {
      /* no answer: the usage from answers stays */
    }
  }

  /** Runs one AI step the chat server asked for. Throws a StepError. */
  async run(req: unknown, signal: AbortSignal, emit: (e: ClaudeCodeEvent) => void): Promise<void> {
    await this.loaded;
    if (!this.report().ready || !this.bin) throw new StepError("cc_unavailable", "Claude Code login is not switched on in your desktop app.");
    const r = validate(req);
    if (this.runs >= MAX_RUNS) throw new StepError("busy", "Several answers are already running on your Claude Code login. Try again in a moment.");
    this.runs++;
    try {
      const cwd = await this.d.workDir();
      const userId = this.active;
      const onRateLimit = (info: unknown) => {
        if (this.active === userId && this.usage.applyEvent(info)) this.notify();
      };
      await runStep(r, { query: await this.d.query(), makeTools: this.d.makeTools, bin: this.bin, cwd, env: claudeEnv(), onRateLimit }, emit, signal);
    } finally {
      this.runs--;
    }
  }
}

/** The chat server's request, checked again here: this app does not trust a frame just because it came down its own connection. */
export function validate(raw: unknown): ClaudeCodeRequest {
  const bad = () => new StepError("bad_request", "That request was not valid.");
  if (!raw || typeof raw !== "object") throw bad();
  const r = raw as Record<string, unknown>;
  if (!isClaudeCodeModel(r.model) || typeof r.system !== "string" || typeof r.prompt !== "string" || r.system.length > CC.systemChars || r.prompt.length > CC.promptChars + 2000 || !r.prompt.trim()) throw bad();
  const efforts: readonly unknown[] = ["off", "low", "medium", "high", "xhigh", "max"];
  const effort = r.effort === null || r.effort === undefined ? null : efforts.includes(r.effort) ? (r.effort as ClaudeCodeEffort) : null;
  if (!Array.isArray(r.tools) || r.tools.length > CC.tools) throw bad();
  const tools = r.tools.map((t): ClaudeCodeRequest["tools"][number] => {
    const x = (t ?? {}) as Record<string, unknown>;
    if (typeof x.name !== "string" || !x.name || x.name.length > CC.toolNameChars || typeof x.description !== "string" || x.description.length > CC.descriptionChars) throw bad();
    const schema = x.inputSchema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema) || JSON.stringify(schema).length > CC.schemaChars) throw bad();
    return { name: x.name, description: x.description, inputSchema: schema as Record<string, unknown> };
  });
  return { model: r.model, system: r.system, prompt: r.prompt, effort, tools };
}
