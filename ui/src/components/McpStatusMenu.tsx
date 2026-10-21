import type { McpRemoteList, McpRemoteServer } from "@mc/shared";
import { ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { useApp } from "../data.tsx";
import { mcpBridge, useMcp } from "../lib/folder.ts";
import { ICON_SM, STROKE, useToast } from "./kit.tsx";

// The flyout of the account menu's "MCP servers" item: one row per server (remote ones from the chat server, plus the ones
// on this computer in the desktop app) with a status dot. A yellow or red dot grows on hover into the action it needs.

export type McpRowState = "ready" | "signin" | "failed" | "connecting" | "off";
type Row = { key: string; name: string; state: McpRowState; error?: string; remote?: McpRemoteServer; local?: string };

const STATE_LABEL: Record<McpRowState, string> = { ready: "Connected", signin: "Needs sign in", failed: "Failed", connecting: "Connecting", off: "Off" };
const REMOTE_STATE: Record<McpRemoteServer["status"], McpRowState> = { ready: "ready", needs_sign_in: "signin", failed: "failed", connecting: "connecting", off: "off" };
const LOCAL_STATE = { ready: "ready", failed: "failed", starting: "connecting", off: "off" } as const;

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : "Something went wrong. Try again.");

/** The person's servers and their status, kept current: on mount, when the window gets focus, and every 5 s while one is connecting. */
export function useMcpStatus() {
  const { info, set } = useMcp();
  const [list, setList] = useState<McpRemoteList | null>(null);
  const [failed, setFailed] = useState(false);
  const [pollUntil, setPollUntil] = useState(0);
  const live = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await api.mcpServers();
      if (live.current) {
        setList(next);
        setFailed(false);
      }
    } catch {
      if (live.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      live.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const rows: Row[] = [
    ...(list?.servers ?? []).map((s): Row => ({ key: s.id, name: s.name, state: REMOTE_STATE[s.status], error: s.error, remote: s })),
    ...(info?.servers ?? []).map((s): Row => ({ key: `local:${s.name}`, name: s.name, state: LOCAL_STATE[s.status], error: s.error, local: s.name })),
  ];
  const busy = rows.some((r) => r.state === "connecting") || Date.now() < pollUntil;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 5000); // slower than the settings page's 2 s: both can be polling, and the list route allows 60 a minute
    return () => clearInterval(t);
  }, [busy, load]);

  return {
    rows,
    /** false until the first answer (or failure) of the chat server. */
    loaded: list !== null || failed,
    failed: failed && list === null,
    oauthAvailable: list?.oauthAvailable ?? false,
    /** True when a server needs the person: signed out or failed. */
    attention: rows.some((r) => r.state === "signin" || r.state === "failed"),
    reload: load,
    /** Keep refreshing for a while, e.g. while the person signs in in the browser. */
    watch: () => setPollUntil(Date.now() + 10 * 60_000),
    put: (s: McpRemoteServer) => setList((l) => (l ? { ...l, servers: l.servers.map((x) => (x.id === s.id ? s : x)) } : l)),
    setLocal: set,
  };
}
export type McpStatus = ReturnType<typeof useMcpStatus>;

/** The status dot on the "MCP servers" item itself: shown only when a server needs the person. */
export function McpAttentionDot() {
  return <span className="mdot signin" role="img" aria-label="A server needs attention" />;
}

function StatusRow({ row, s, close }: { row: Row; s: McpStatus; close: () => void }) {
  const { openSettings } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [retriedFailed, setRetriedFailed] = useState(false); // a retry came back failed: next click opens the settings instead
  const tried = useRef(false);
  useEffect(() => {
    if (row.state === "failed" && tried.current) setRetriedFailed(true);
    if (row.state === "ready") {
      tried.current = false;
      setRetriedFailed(false);
    }
  }, [row.state]);

  const manage = () => {
    close();
    openSettings("mcp", row.local ? `local:${row.local}` : row.remote?.id);
  };
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast.push(messageOf(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const signIn = () =>
    run(async () => {
      const { url } = await api.mcpSignIn(row.remote!.id);
      if (url && /^https:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer"); // the desktop app hands https pages to the system browser
      s.watch();
      await s.reload();
    });
  const retry = () =>
    run(async () => {
      tried.current = true;
      if (row.local) {
        s.setLocal(await mcpBridge()!.retry(row.local));
        return;
      }
      const next = await api.mcpRetry(row.remote!.id);
      s.put(next);
      s.watch();
      if (next.status === "failed") setRetriedFailed(true);
    });

  const action: { label: string; go: () => void } | null =
    row.state === "signin" ? (row.remote && s.oauthAvailable ? { label: "Sign in", go: () => void signIn() } : { label: "Set up", go: manage })
    : row.state === "failed" ? (retriedFailed ? { label: "Open settings", go: manage } : { label: "Retry", go: () => void retry() })
    : null;
  const shown: McpRowState = busy ? "connecting" : row.state;
  const inactive = busy || row.state === "connecting";
  const label = `${row.name}, ${STATE_LABEL[shown]}${action && !busy ? `. ${action.label}` : ""}`;

  return (
    <button
      type="button"
      role="menuitem"
      className="menu-item mcp-row"
      aria-label={label}
      aria-disabled={inactive || undefined}
      title={row.state === "failed" && row.error ? row.error : undefined}
      onClick={inactive ? undefined : action ? action.go : manage}
    >
      <span className="grow truncate">{row.name}</span>
      <span className={`mcp-flag ${action && !busy ? "has-action" : ""} ${shown}`} aria-hidden>
        <span className={`mdot ${shown}`} />
        {action && !busy && <span className="mcp-flag-text">{action.label}</span>}
      </span>
    </button>
  );
}

/** The flyout's content. */
export function McpFlyout({ s, close }: { s: McpStatus; close: () => void }) {
  const { openSettings } = useApp();
  const { reload } = s;
  useEffect(() => void reload(), [reload]); // opening the flyout reads the status again
  const manage = () => {
    close();
    openSettings("mcp");
  };
  return (
    <>
      {!s.loaded && s.rows.length === 0 && (
        <div className="mcp-skeleton" aria-hidden>
          <span />
          <span />
        </div>
      )}
      {s.failed && s.rows.length === 0 && (
        <button type="button" role="menuitem" className="menu-item" onClick={() => void reload()}>
          <span className="grow muted">Couldn't load. Try again</span>
        </button>
      )}
      {s.loaded && !s.failed && s.rows.length === 0 && (
        <>
          <p className="mcp-empty small muted">No servers yet</p>
          <div className="menu-divider" role="separator" />
          <button type="button" role="menuitem" className="menu-item" onClick={manage}>
            <span className="grow">Add a server…</span>
          </button>
        </>
      )}
      {s.rows.map((r) => (
        <StatusRow key={r.key} row={r} s={s} close={close} />
      ))}
      {s.rows.length > 0 && (
        <>
          <div className="menu-divider" role="separator" />
          <button type="button" role="menuitem" className="menu-item" onClick={manage}>
            <span className="grow">Manage servers…</span>
            <ArrowUpRight size={ICON_SM} strokeWidth={STROKE} className="muted" aria-hidden />
          </button>
        </>
      )}
    </>
  );
}
