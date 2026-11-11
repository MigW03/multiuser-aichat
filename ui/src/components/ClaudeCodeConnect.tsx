import { PROVIDER_LABELS } from "@mc/shared";
import { ExternalLink, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useApp } from "../data.tsx";
import { CLAUDE_INSTALL_URL, CLAUDE_LOGIN_COMMAND, claudeCodeBridge, useClaudeCode, type ClaudeCodeResult } from "../lib/claudeCode.ts";
import { copyText } from "../lib/actions.ts";
import { forgetModels } from "../lib/models.ts";
import { ClaudeCodeUsageBlock } from "./PlanUsage.tsx";
import { Button, ErrorLine, ICON_SM, STROKE, useToast } from "./kit.tsx";

const LINK = { off: "Not connected to the chat yet", connecting: "Connecting to the chat…", connected: "Connected to the chat", auth: "Sign-in needs refreshing" } as const;

/** What the AI may do with the login, in plain words. Shown before it is switched on, and again by the app's own window. */
export function ClaudeCodeWarning() {
  return (
    <div className="cc-warning" role="note">
      <b>Read this first</b>
      <ul>
        <li>
          Anthropic's terms are written for using Claude Code itself. Using your Claude subscription through another app may not be allowed, and Anthropic could limit or suspend your account. You take that risk.
        </li>
        <li>Nido runs the real <code>claude</code> program on this computer, with the login you made yourself. Nido never sees, reads or stores that login.</li>
        <li>It is only used for answers you ask for, on this computer, and never for anyone else's questions. It does not work in the web version.</li>
        <li>Whatever is used to answer you, including what other people wrote in a shared chat, goes to Claude through your account.</li>
      </ul>
    </div>
  );
}

/**
 * Settings > AI key > Claude Code login (desktop app only). Off until the person switches it on in a window the app opens itself.
 * They sign in to Claude Code themselves in a terminal; this page only shows what `claude` reports about that.
 */
export function ClaudeCodeConnect() {
  const bridge = claudeCodeBridge();
  const { status, set, refresh } = useClaudeCode();
  const { reloadKeys } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!bridge) {
    return <p className="small muted">{PROVIDER_LABELS.claudecode} works in the Nido desktop app only: it needs the Claude Code program on your computer.</p>;
  }
  if (!status) return <p className="small muted">Looking for Claude Code…</p>;

  // The chat server hears about the change over the app's connection a moment later; the key list follows.
  const settled = () => {
    forgetModels("claudecode");
    for (const wait of [400, 1500, 4000]) setTimeout(reloadKeys, wait);
  };
  const run = async (f: () => Promise<ClaudeCodeResult>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await f();
      set(r.status);
      if (r.error) setError(r.error);
      settled();
      return r;
    } catch {
      setError("Something went wrong. Try again.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const signedOut = status.login === "signed_out";
  const found = status.binary !== null;

  return (
    <div className="col" style={{ gap: 14 }}>
      {!status.enabled && <ClaudeCodeWarning />}
      <div className="cc-status">
        <div>
          <div className="strong">Claude Code program</div>
          <p className="small muted">{found ? `${status.binary}${status.custom ? " (chosen by you)" : ""}` : "Not found on this computer."}</p>
        </div>
        <div>
          <div className="strong">Sign-in</div>
          <p className="small muted">{!found ? "Needs the program first." : status.login === "signed_in" ? `Signed in${status.account ? ` as ${status.account}` : ""}` : signedOut ? "Not signed in." : "Not checked yet."}</p>
        </div>
        {status.enabled && (
          <div>
            <div className="strong">Chat</div>
            <p className="small muted">{LINK[status.link]}</p>
          </div>
        )}
      </div>

      {status.enabled && status.login !== "signed_out" && <ClaudeCodeUsageBlock />}

      {!found && (
        <p className="small muted">
          Install Claude Code, then come back.{" "}
          <a href={CLAUDE_INSTALL_URL} target="_blank" rel="noopener noreferrer">
            How to install it <ExternalLink size={11} strokeWidth={STROKE} aria-hidden />
          </a>
        </p>
      )}
      {found && signedOut && (
        <p className="small">
          Sign in yourself in a terminal: <code>{CLAUDE_LOGIN_COMMAND}</code>{" "}
          <Button size="sm" variant="ghost" onClick={() => void copyText(CLAUDE_LOGIN_COMMAND).then(() => toast.push("Copied"))}>
            Copy
          </Button>
        </p>
      )}
      {status.error && status.enabled && <p className="small mcp-error">{status.error}</p>}
      <ErrorLine>{error}</ErrorLine>

      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {status.enabled ? (
          <Button variant="primary" busy={busy} onClick={() => void run(() => bridge.setEnabled(false))}>
            Switch off
          </Button>
        ) : (
          <Button variant="primary" busy={busy} disabled={!found || signedOut} onClick={() => void run(() => bridge.setEnabled(true))}>
            Switch on…
          </Button>
        )}
        <Button variant="ghost" busy={busy} onClick={refresh}>
          <RotateCcw size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Check again
        </Button>
        <Button variant="ghost" busy={busy} onClick={() => void run(() => bridge.chooseBinary())}>
          Choose the program…
        </Button>
        {status.custom && (
          <Button variant="ghost" busy={busy} onClick={() => void bridge.resetBinary().then(set)}>
            Use the usual one
          </Button>
        )}
      </div>
    </div>
  );
}
