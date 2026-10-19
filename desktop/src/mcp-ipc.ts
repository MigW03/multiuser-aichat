import { app, BrowserWindow, dialog, ipcMain, safeStorage, type IpcMainInvokeEvent } from "electron";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FolderError } from "./folder-fs.ts";
import { isUuid, originOf, serverSocketUrl } from "./folder-host.ts";
import { McpConn, type McpLink } from "./mcp-conn.ts";
import { parseCommandLine, parseConfig, parseEnvText, serializeConfig, showCommand, validateName, type McpConfig, type Vault } from "./mcp-config.ts";
import { McpHost, type McpView } from "./mcp-host.ts";

// Wires connected tools (MCP) to the app window. They belong to the signed-in person, not to a project: the page tells the
// app who is signed in, and the app keeps one connection to the chat server for that person. The page can read the setup
// and change switches; it can never start a program by itself: adding a server shows its exact command line in a window
// the app opens itself, which the page cannot click, and the server is added only if the person confirms there.

const STORE = () => join(app.getPath("userData"), "mcp-servers.json");

const vault: Vault = {
  // On Linux without a keyring Electron falls back to a fixed built-in password ("basic_text"), which protects nothing.
  available: () => safeStorage.isEncryptionAvailable() && !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
  encrypt: (text) => safeStorage.encryptString(text).toString("base64"),
  decrypt: (blob) => safeStorage.decryptString(Buffer.from(blob, "base64")),
};

export type McpInfo = McpView & {
  /** false when this computer has no secure storage: servers can't hold environment variables then. */
  secureStorage: boolean;
  /** The connection to the chat server: the AI can use these tools only while "connected". */
  link: McpLink;
};

type Session = { serverUrl: string; token: string; userId: string };

export function setupMcp(opts: { allowedOrigin: string; getWindow: () => BrowserWindow | null }) {
  let session: Session | null = null;
  let conn: McpConn | null = null;
  let connUser: string | null = null;

  const changed = () => {
    opts.getWindow()?.webContents.send("mcp:changed");
    conn?.stateChanged();
  };

  const host = new McpHost(
    {
      load: async () => {
        try {
          return parseConfig(await readFile(STORE(), "utf8"), vault, isUuid);
        } catch {
          return {} as McpConfig;
        }
      },
      save: async (config) => {
        const file = STORE();
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, serializeConfig(config, vault), { mode: 0o600 });
        await rename(tmp, file);
        await chmod(file, 0o600).catch(() => undefined);
      },
    },
    { cwd: join(app.getPath("userData"), "mcp-work"), onChange: changed },
  );

  /** Opens (or closes) the connection for whoever is signed in; their servers start, anyone else's stop. */
  function reconcile() {
    const wsUrl = session ? serverSocketUrl(session.serverUrl, app.isPackaged, "/api/mcp-host") : null;
    const userId = session && wsUrl ? session.userId : null;
    if (conn && connUser !== userId) {
      conn.close();
      conn = null;
      connUser = null;
    }
    if (userId && wsUrl && !conn) {
      connUser = userId;
      conn = new McpConn({
        wsUrl,
        getToken: () => session?.token ?? "",
        getState: () => host.state(),
        call: async (req, signal) => {
          const r = req as { id: string; server?: unknown; tool?: unknown; args?: unknown };
          try {
            return { id: r.id, ok: true, result: await host.call(r, signal) };
          } catch (err) {
            if (err instanceof FolderError) return { id: r.id, ok: false, code: err.code, message: err.message };
            throw err;
          }
        },
        onLink: changed,
      });
    }
    void host.setUser(userId);
  }

  const trusted = (e: IpcMainInvokeEvent) => originOf(e.senderFrame?.url) === opts.allowedOrigin;
  const info = async (userId: string): Promise<McpInfo> => ({ ...(await host.view(userId)), secureStorage: vault.available(), link: conn?.link ?? "off" });
  const none: McpInfo = { servers: [], secureStorage: false, link: "off" };
  /** The signed-in person, when the caller is the app's own page. Nothing else may change or read the setup. */
  const me = (e: IpcMainInvokeEvent): string | null => (trusted(e) ? host.currentUser() : null);

  async function confirmAdd(name: string, command: string[], envKeys: string[]): Promise<boolean> {
    const detail = [
      `Name: ${name}`,
      "",
      "Command (each part in quotes):",
      showCommand(command),
      "",
      envKeys.length ? `Environment variables set for it: ${envKeys.join(", ")}` : "No extra environment variables.",
      "",
      "This program will run on your computer with your user's rights, and can read or change anything you can.",
      "While it is on, the AI can use its tools whenever you ask it something, in any chat, and nothing asks you before each use. Other people in a chat cannot use your tools, but whatever a tool returns goes into that chat, which they can read, and to the AI provider.",
      "You can switch it off, or remove it, any time in Settings > MCP servers.",
    ].join("\n");
    const options = { type: "warning" as const, title: "Start this tool server?", message: "Add and run this tool server on your computer?", detail, buttons: ["Cancel", "Add and run"], defaultId: 0, cancelId: 0, noLink: true };
    const win = opts.getWindow();
    const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return r.response === 1;
  }

  // Who is signed in, and a token for the chat server. null = signed out: everything stops.
  ipcMain.handle("mcp:set-session", async (e, raw: unknown) => {
    if (!trusted(e)) return;
    const s = raw as Partial<Session> | null;
    if (s && typeof s.serverUrl === "string" && typeof s.token === "string" && s.token.length > 0 && s.token.length <= 4096 && isUuid(s.userId)) {
      const tokenChanged = session?.token !== s.token;
      session = { serverUrl: s.serverUrl, token: s.token, userId: s.userId };
      reconcile();
      if (tokenChanged) conn?.tokenChanged();
    } else {
      session = null;
      reconcile();
    }
  });

  ipcMain.handle("mcp:get", async (e): Promise<McpInfo> => {
    const user = me(e);
    return user ? info(user) : none;
  });

  // The page sends what the person typed; the app shows exactly what will run, in its own window.
  ipcMain.handle("mcp:add", async (e, raw: unknown): Promise<{ ok: true; info: McpInfo } | { ok: false; error: string | null }> => {
    const user = me(e);
    if (!user) return { ok: false, error: "Sign in first." };
    try {
      const r = (raw ?? {}) as { name?: unknown; command?: unknown; env?: unknown };
      const name = validateName(r.name);
      const command = parseCommandLine(r.command);
      const env = parseEnvText(r.env);
      if (Object.keys(env).length && !vault.available()) throw new FolderError("bad_request", "This computer has no secure storage for secrets, so environment variables can't be saved.");
      if (!(await confirmAdd(name, command, Object.keys(env)))) return { ok: false, error: null };
      if (host.currentUser() !== user) return { ok: false, error: "You were signed out." };
      await host.add(user, name, command, env);
      return { ok: true, info: await info(user) };
    } catch (err) {
      if (err instanceof FolderError) return { ok: false, error: err.message };
      console.error("[mcp] could not add a server:", err instanceof Error ? err.message : err);
      return { ok: false, error: "The server could not be added." };
    }
  });

  ipcMain.handle("mcp:remove", async (e, name: unknown): Promise<McpInfo> => {
    const user = me(e);
    if (!user || typeof name !== "string") return none;
    await host.remove(user, name);
    return info(user);
  });

  ipcMain.handle("mcp:set-server", async (e, name: unknown, enabled: unknown): Promise<McpInfo> => {
    const user = me(e);
    if (!user || typeof name !== "string" || typeof enabled !== "boolean") return none;
    await host.setServerEnabled(user, name, enabled);
    return info(user);
  });

  ipcMain.handle("mcp:set-tool", async (e, name: unknown, tool: unknown, enabled: unknown): Promise<McpInfo> => {
    const user = me(e);
    if (!user || typeof name !== "string" || typeof tool !== "string" || typeof enabled !== "boolean") return none;
    await host.setToolEnabled(user, name, tool, enabled);
    return info(user);
  });

  ipcMain.handle("mcp:retry", async (e, name: unknown): Promise<McpInfo> => {
    const user = me(e);
    if (!user || typeof name !== "string") return none;
    await host.retry(user, name);
    return info(user);
  });

  app.on("before-quit", () => {
    conn?.close();
    void host.closeAll();
  });
  return host;
}
