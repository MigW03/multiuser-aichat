import { MCP_LIMITS as M } from "@mc/shared";
import { FolderError } from "./folder-fs.ts";

// What a person has set up for connected tools (MCP), per signed-in user on this computer: their tool servers. A server is
// a command this app starts on this computer; the person's own account uses it, in whatever chat they ask the AI in. Nothing here is ever sent to the chat server or read
// by the page except through `views` (names, the command line and the NAMES of environment variables, never their values).

export type McpServerSpec = {
  /** Program and arguments, one entry each. Never run through a shell. */
  command: string[];
  /** Extra environment for the server (API keys and the like). Values stay on this computer. */
  env: Record<string, string>;
  enabled: boolean;
  /** Tools of this server the person switched off. */
  disabledTools: string[];
};
export type McpUserConfig = { servers: Record<string, McpServerSpec> };
/** By user id: two accounts on one computer never see each other's servers. */
export type McpConfig = Record<string, McpUserConfig>;

/** Encrypts the values of a server's environment on disk. The OS keychain is behind it in the app. */
export type Vault = { available: () => boolean; encrypt: (text: string) => string; decrypt: (blob: string) => string };

export const EMPTY_USER = (): McpUserConfig => ({ servers: {} });

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/;
const NAME = new RegExp(`^[A-Za-z0-9_-]{1,${M.nameChars}}$`);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const bad = (message: string) => new FolderError("bad_request", message);

export function validateName(name: unknown): string {
  if (typeof name !== "string" || !NAME.test(name)) throw bad(`A server name is 1 to ${M.nameChars} letters, digits, "-" or "_".`);
  return name;
}

export function validateCommand(command: unknown): string[] {
  if (!Array.isArray(command) || command.length === 0 || command.length > M.commandParts) throw bad(`The command needs 1 to ${M.commandParts} parts (the program, then its arguments).`);
  const parts = command.map((p) => {
    if (typeof p !== "string" || p.length > M.partChars || CONTROL.test(p)) throw bad(`Each part of the command must be text of up to ${M.partChars} characters, without control or invisible characters.`);
    return p;
  });
  if (parts[0]!.trim() === "") throw bad("The first part of the command is the program to start.");
  return parts;
}

export function validateEnv(env: unknown): Record<string, string> {
  if (env === undefined || env === null) return {};
  if (typeof env !== "object" || Array.isArray(env)) throw bad("Environment must be KEY=value pairs.");
  const entries = Object.entries(env as Record<string, unknown>);
  if (entries.length > M.envVars) throw bad(`At most ${M.envVars} environment variables.`);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!ENV_KEY.test(k)) throw bad(`"${k.slice(0, 40)}" is not a valid environment variable name.`);
    if (typeof v !== "string" || v.length > M.envValueChars || v.includes("\u0000")) throw bad(`The value of ${k} must be text of up to ${M.envValueChars} characters.`);
    out[k] = v;
  }
  return out;
}

/** The command line as the host reads it: every part in quotes, so where one ends and the next starts is visible. */
export const showCommand = (command: string[]) => command.map((p) => JSON.stringify(p)).join(" ");

// ------------------------------------------------------------------ the file

type Stored = { version: 2; users: Record<string, { servers?: Record<string, { command?: unknown; envEnc?: unknown; enabled?: unknown; disabledTools?: unknown }> }> };

/** Reads the file's text. Anything that doesn't check out is dropped, never half-trusted. */
export function parseConfig(text: string, vault: Vault, isUserId: (v: string) => boolean): McpConfig {
  let raw: Stored;
  try {
    raw = JSON.parse(text) as Stored;
  } catch {
    return {};
  }
  const out: McpConfig = {};
  for (const [userId, p] of Object.entries(raw?.users ?? {})) {
    if (!isUserId(userId) || typeof p !== "object" || p === null) continue;
    const user = EMPTY_USER();
    for (const [name, s] of Object.entries(p.servers ?? {}).slice(0, M.servers)) {
      try {
        const command = validateCommand(s?.command);
        let env: Record<string, string> = {};
        if (typeof s?.envEnc === "string" && s.envEnc !== "") {
          try {
            env = validateEnv(JSON.parse(vault.decrypt(s.envEnc)));
          } catch {
            env = {}; // the keychain entry is gone (another user, another machine): the host has to enter the values again
          }
        }
        const disabled = Array.isArray(s?.disabledTools) ? s.disabledTools.filter((t): t is string => typeof t === "string" && t.length <= M.toolNameChars).slice(0, 500) : [];
        user.servers[validateName(name)] = { command, env, enabled: s?.enabled !== false, disabledTools: disabled };
      } catch {
        /* a bad entry is left out */
      }
    }
    out[userId] = user;
  }
  return out;
}

export function serializeConfig(config: McpConfig, vault: Vault): string {
  const users: Stored["users"] = {};
  for (const [userId, p] of Object.entries(config)) {
    const servers: NonNullable<Stored["users"][string]["servers"]> = {};
    for (const [name, s] of Object.entries(p.servers)) {
      const hasEnv = Object.keys(s.env).length > 0;
      // Values are never written in the clear: without a keychain a server with secrets can't be saved at all.
      if (hasEnv && !vault.available()) throw bad("This computer has no secure storage for secrets, so servers with environment variables can't be saved.");
      servers[name] = { command: s.command, enabled: s.enabled, disabledTools: s.disabledTools, ...(hasEnv ? { envEnc: vault.encrypt(JSON.stringify(s.env)) } : {}) };
    }
    users[userId] = { servers };
  }
  return JSON.stringify({ version: 2, users } satisfies Stored);
}

// ------------------------------------------------------------------ what the host types

/**
 * Splits a command line into program and arguments the way a person reads it: spaces separate, "double" or 'single'
 * quotes keep spaces together. No shell is involved, so nothing is expanded ($VAR, ~, *, pipes are plain characters).
 * The host sees the result, every part in quotes, before anything runs.
 */
export function parseCommandLine(text: unknown): string[] {
  if (typeof text !== "string") throw bad("Type the command to run.");
  const parts: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) cur += text[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur !== "") parts.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (quote) throw bad("A quote in the command is not closed.");
  if (has || cur !== "") parts.push(cur);
  return validateCommand(parts);
}

/** Lines of KEY=value; blank lines and lines starting with # are ignored; a value may be wrapped in quotes. */
export function parseEnvText(text: unknown): Record<string, string> {
  if (text === undefined || text === null || text === "") return {};
  if (typeof text !== "string") throw bad("Environment must be KEY=value lines.");
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) throw bad(`"${t.slice(0, 40)}" is not KEY=value.`);
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    if (key in env) throw bad(`${key.slice(0, 40)} is set twice.`);
    env[key] = value;
  }
  return validateEnv(env);
}
