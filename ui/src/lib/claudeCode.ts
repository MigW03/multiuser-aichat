import type { ClaudeCodeStatus, ClaudeCodeUsage } from "@mc/shared";
import { useEffect, useState } from "react";

// "Use my Claude Code login": only in the desktop app. The app runs the person's own `claude` program; the page can read the
// status and ask to switch it on or off (the app asks in a window of its own), and ask to pick the program. It handles no path
// and no sign-in.

export type ClaudeCodeResult = { ok: boolean; error: string | null; status: ClaudeCodeStatus };
export type ClaudeCodeBridge = {
  get: () => Promise<ClaudeCodeStatus>;
  /** Looks for `claude` again and asks it whether it is signed in. */
  refresh: () => Promise<ClaudeCodeStatus>;
  /** The plan limits `claude` reported, or null when none are known. `refresh` asks `claude` directly first. */
  usage: (refresh: boolean) => Promise<ClaudeCodeUsage | null>;
  setEnabled: (enabled: boolean) => Promise<ClaudeCodeResult>;
  chooseBinary: () => Promise<ClaudeCodeResult>;
  resetBinary: () => Promise<ClaudeCodeStatus>;
  onChange: (callback: () => void) => () => void;
};

export const claudeCodeBridge = (): ClaudeCodeBridge | null => (globalThis as { desktop?: { claudeCode?: ClaudeCodeBridge } }).desktop?.claudeCode ?? null;

/** The command the person runs themselves in a terminal to sign in. The app never runs it. */
export const CLAUDE_LOGIN_COMMAND = "claude auth login";
export const CLAUDE_INSTALL_URL = "https://code.claude.com/docs/en/quickstart";

/** The status, current as the app changes it. null in a browser or an older app, or until loaded. */
export function useClaudeCode(): { status: ClaudeCodeStatus | null; set: (s: ClaudeCodeStatus) => void; refresh: () => void } {
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
  const bridge = claudeCodeBridge();
  useEffect(() => {
    if (!bridge) return setStatus(null);
    let live = true;
    const load = () => void bridge.get().then((v) => live && setStatus(v), () => undefined);
    load();
    // Looking for `claude` and asking about its sign-in happens when the page is opened, not on every change.
    void bridge.refresh().then((v) => live && setStatus(v), () => undefined);
    const off = bridge.onChange(load);
    return () => {
      live = false;
      off();
    };
  }, [bridge]);
  return {
    status,
    set: setStatus,
    refresh: () => void bridge?.refresh().then(setStatus, () => undefined),
  };
}
