import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { verifyClaude } from "./claude-code-bin.ts";
import { ClaudeCodeHost, parseClaudeCodeConfig } from "./claude-code-host.ts";
import { makeToolServer } from "./claude-code-tools.ts";
import { isUuid, originOf } from "./folder-host.ts";
import { StepError, type QueryFn } from "./claude-code-run.ts";

// Wires "Use my Claude Code login" to the app window. It belongs to the signed-in person on this computer, is OFF until they
// switch it on (in a window the page cannot click, which says what it means), and only ever runs the `claude` program they
// signed in to themselves. The page can read the status and ask for the switches; it can name no path and read no secret.

const STORE = () => join(app.getPath("userData"), "claude-code.json");

const RISK = [
  "Nido will run the `claude` program on this computer, with the login you made yourself (`claude auth login`), to answer when YOU ask the AI something. Nido never sees, reads or stores that login.",
  "",
  "Anthropic's terms are written for using Claude Code itself. Using your Claude subscription through another app like Nido may not be allowed, and Anthropic could limit or suspend your account. You take that risk. Use it for yourself only: it is never used for anyone else's questions, and never on a server.",
  "",
  "Whatever is used to answer you goes to Claude through your account: your message, and the other messages, files and tool results of the chat, including what other people wrote there.",
  "",
  "It is off until you switch it on, and you can switch it off at any time in Settings.",
].join("\n");

// Anthropic's Agent SDK is proprietary ("all rights reserved", used under Anthropic's legal agreements), so it is NOT bundled into
// the app: it is loaded from node_modules when it is there (a development run of the app), and is simply missing from a packaged
// release, where the switch then says so. The specifier is a variable so the bundler leaves the import alone.
const SDK = "@anthropic-ai/claude-agent-sdk";
async function loadQuery(): Promise<QueryFn> {
  try {
    return ((await import(SDK)) as { query: unknown }).query as QueryFn;
  } catch {
    throw new StepError("cc_unavailable", "This build of the app does not include the Claude Code SDK.");
  }
}

export function setupClaudeCode(opts: { allowedOrigin: string; getWindow: () => BrowserWindow | null }): ClaudeCodeHost {
  const host: ClaudeCodeHost = new ClaudeCodeHost({
    store: {
      load: async () => {
        try {
          return parseClaudeCodeConfig(await readFile(STORE(), "utf8"), isUuid);
        } catch {
          return {};
        }
      },
      save: async (config) => {
        const file = STORE();
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, JSON.stringify(config), { mode: 0o600 });
        await rename(tmp, file);
        await chmod(file, 0o600).catch(() => undefined);
      },
    },
    workDir: async () => {
      const dir = join(app.getPath("userData"), "claude-code-work");
      await mkdir(dir, { recursive: true });
      return dir;
    },
    query: loadQuery,
    available: async () => {
      try {
        await loadQuery();
        return true;
      } catch {
        return false;
      }
    },
    makeTools: makeToolServer,
    onChange: () => {
      opts.getWindow()?.webContents.send("claudecode:changed");
    },
  });

  const trusted = (e: IpcMainInvokeEvent) => originOf(e.senderFrame?.url) === opts.allowedOrigin;
  const me = (e: IpcMainInvokeEvent): string | null => (trusted(e) ? host.currentUser() : null);
  const off = { enabled: false, binary: null, custom: false, login: "unknown", account: null, error: null, link: "off" } as const;

  async function confirmEnable(binary: string | null): Promise<boolean> {
    const options = {
      type: "warning" as const,
      title: "Use your Claude Code login?",
      message: "Let Nido's AI use your Claude Code login?",
      detail: `${binary ? `Program: ${binary}\n\n` : ""}${RISK}`,
      buttons: ["Cancel", "Switch on"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const win = opts.getWindow();
    const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return r.response === 1;
  }

  ipcMain.handle("claudecode:get", async (e) => (me(e) ? host.status() : off));

  // The person's plan limits as their own `claude` reports them: only for the app's own page, only for the signed-in person.
  ipcMain.handle("claudecode:usage", async (e, refresh: unknown) => (me(e) ? host.getUsage(refresh === true) : null));

  ipcMain.handle("claudecode:refresh", async (e) => {
    if (!me(e)) return off;
    await host.refresh(); // looks for `claude` and asks it about its sign-in; it switches nothing on
    return host.status();
  });

  // Switching on asks in a window of the app's own, after checking that a real `claude` is there to run.
  ipcMain.handle("claudecode:set-enabled", async (e, enabled: unknown): Promise<{ ok: boolean; error: string | null; status: Awaited<ReturnType<ClaudeCodeHost["status"]>> }> => {
    const user = me(e);
    if (!user || typeof enabled !== "boolean") return { ok: false, error: "Sign in first.", status: off };
    try {
      if (enabled) {
        if (!(await host.status()).enabled) {
          // Nothing is switched on until the person agrees: look for `claude` first, so the window can name the program.
          const binary = await host.detect(user);
          if (!(await host.sdkAvailable())) return { ok: false, error: "This build of the app does not include the Claude Code SDK, so the login cannot be used here.", status: await host.status() };
          if (!binary) return { ok: false, error: "Claude Code was not found on this computer. Install it, run `claude auth login`, then try again (or choose its location).", status: await host.status() };
          if (!(await confirmEnable(binary))) return { ok: false, error: null, status: await host.status() };
          if (host.currentUser() !== user) return { ok: false, error: "You were signed out.", status: off };
          await host.setEnabled(user, true);
        }
      } else {
        await host.setEnabled(user, false);
      }
      return { ok: true, error: null, status: await host.status() };
    } catch (err) {
      console.error("[claudecode] could not change the switch:", err instanceof Error ? err.message : err);
      return { ok: false, error: "That could not be saved.", status: await host.status() };
    }
  });

  // The person picks a program in the system's own dialog; it counts only if it really is Claude Code.
  ipcMain.handle("claudecode:choose-binary", async (e): Promise<{ ok: boolean; error: string | null; status: Awaited<ReturnType<ClaudeCodeHost["status"]>> }> => {
    const user = me(e);
    if (!user) return { ok: false, error: "Sign in first.", status: off };
    const win = opts.getWindow();
    const picked = await (win ? dialog.showOpenDialog(win, { title: "Choose the claude program", properties: ["openFile"] }) : dialog.showOpenDialog({ title: "Choose the claude program", properties: ["openFile"] }));
    const path = picked.canceled ? null : (picked.filePaths[0] ?? null);
    if (!path) return { ok: true, error: null, status: await host.status() };
    if (!(await verifyClaude(path))) return { ok: false, error: "That is not the Claude Code program.", status: await host.status() };
    await host.setBinary(user, path);
    return { ok: true, error: null, status: await host.status() };
  });

  ipcMain.handle("claudecode:reset-binary", async (e) => {
    const user = me(e);
    if (!user) return off;
    await host.setBinary(user, null);
    return host.status();
  });

  return host;
}
