import type { McpRemoteList, McpRemoteServer } from "@mc/shared";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { ToolList } from "./McpSettings.tsx";
import { Button, Dialog, ErrorLine, Field, ICON_SM, STROKE, TextInput } from "./kit.tsx";

// Remote MCP servers in Settings: tool servers at an https address that the chat server calls for you, so they work in the
// web and desktop apps alike. Their sign-in (a header value or OAuth) is kept encrypted on the server and never comes
// back to this page: only the last 4 characters of a header value do.

const STATUS: Record<McpRemoteServer["status"], string> = { connecting: "Connecting…", ready: "Connected", needs_sign_in: "Needs sign in", failed: "Failed", off: "Off" };
const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : "Something went wrong. Try again.");
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The person's remote servers, kept current: refreshed when the window comes back, and every 2 seconds while one is connecting or a sign-in is open. */
function useRemote() {
  const [list, setList] = useState<McpRemoteList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollUntil, setPollUntil] = useState(0);
  const live = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await api.mcpServers();
      if (live.current) {
        setList(next);
        setError(null);
      }
    } catch (e) {
      if (live.current) setError(messageOf(e));
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

  const busy = !!list?.servers.some((s) => s.status === "connecting") || Date.now() < pollUntil;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [busy, load]);

  /** One server changed (an answer from the chat server): replace it in the list. */
  const put = (s: McpRemoteServer) => setList((l) => (l ? { ...l, servers: l.servers.map((x) => (x.id === s.id ? s : x)) } : l));
  return { list, error, load, put, watchSignIn: () => setPollUntil(Date.now() + 10 * 60_000), add: (s: McpRemoteServer) => setList((l) => (l ? { ...l, servers: [...l.servers, s] } : l)), remove: (id: string) => setList((l) => (l ? { ...l, servers: l.servers.filter((x) => x.id !== id) } : l)) };
}

function RemoteRow({ server, oauthAvailable, onChange, onRemove, onWatch, onToken }: { server: McpRemoteServer; oauthAvailable: boolean; onChange: (s: McpRemoteServer) => void; onRemove: () => void; onWatch: () => void; onToken: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  const usable = server.tools.filter((t) => t.usable);

  const signIn = () =>
    run(async () => {
      const { url } = await api.mcpSignIn(server.id);
      if (url) window.open(url, "_blank", "noopener,noreferrer"); // the desktop app hands https pages to the system browser
      onWatch();
    });

  return (
    <div className="setting-row mcp-server">
      <div className="grow">
        <div className="strong">
          {server.name} <span className={`mcp-status ${server.status === "ready" ? "ready" : server.status === "failed" ? "failed" : ""}`}>{STATUS[server.status]}</span>
          {server.status === "ready" && (
            <span className="small muted">
              {" "}
              · {usable.filter((t) => t.enabled).length} of {usable.length} tools on for the AI
            </span>
          )}
        </div>
        <p className="small muted mcp-command" title={server.url}>
          {server.url}
        </p>
        <p className="small muted">{server.authKind === "oauth" ? "Signed in with OAuth" : server.authKind === "header" ? `Header ${server.headerName} ••••${server.secretHint ?? ""}` : "No sign-in"}</p>
        {server.error && server.status !== "ready" && <p className="small mcp-error">{server.error}</p>}
        {server.status === "needs_sign_in" && !oauthAvailable && <p className="small mcp-error">OAuth sign-in is not set up on this chat server.</p>}
        {error && <ErrorLine>{error}</ErrorLine>}
        <div className="mcp-actions">
          {server.status === "needs_sign_in" && oauthAvailable && (
            <Button size="sm" disabled={busy} onClick={() => void signIn()}>
              Sign in
            </Button>
          )}
          {server.status === "failed" && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { onChange(await api.mcpRetry(server.id)); onWatch(); })}>
              <RotateCcw size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Try again
            </Button>
          )}
          {server.tools.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? "Hide tools" : "Show tools"}
            </Button>
          )}
          {server.authKind === "oauth" && server.status === "ready" && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => onChange(await api.mcpSignOut(server.id)))}>
              Sign out
            </Button>
          )}
          {server.authKind === "header" && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onToken}>
              Replace token
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { await api.mcpDelete(server.id); onRemove(); })}>
            <Trash2 size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Remove
          </Button>
        </div>
        {open && <ToolList tools={server.tools} busy={busy} onToggle={(tool, on) => void run(async () => onChange(await api.mcpSet(server.id, { tool: { name: tool, enabled: on } })))} />}
      </div>
      <input
        type="checkbox"
        className="setting-switch"
        role="switch"
        aria-label={`${server.name} on`}
        checked={server.enabled}
        disabled={busy}
        onChange={(e) => void run(async () => onChange(await api.mcpSet(server.id, { enabled: e.target.checked })))}
      />
    </div>
  );
}

type Draft = { name: string; url: string; auth: "none" | "header" | "oauth"; headerName: string; headerValue: string };

function AddRemote({ oauthAvailable, onClose, onAdded }: { oauthAvailable: boolean; onClose: () => void; onAdded: (s: McpRemoteServer) => void }) {
  const [d, setD] = useState<Draft>({ name: "", url: "", auth: oauthAvailable ? "oauth" : "none", headerName: "Authorization", headerValue: "" });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  const problem = !/^[A-Za-z0-9_-]{1,32}$/.test(d.name.trim())
    ? "A name is 1 to 32 letters, digits, - or _."
    : !/^https:\/\//i.test(d.url.trim())
      ? "The address must start with https://."
      : d.auth === "header" && (!/^[A-Za-z0-9-]{1,64}$/.test(d.headerName.trim()) || d.headerValue === "")
        ? "Give the header's name and value."
        : null;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const auth = d.auth === "header" ? ({ kind: "header", name: d.headerName.trim(), value: d.headerValue } as const) : ({ kind: d.auth } as const);
      onAdded(await api.mcpAdd({ name: d.name.trim(), url: d.url.trim(), auth }));
      onClose();
    } catch (e) {
      setError(messageOf(e));
      setConfirming(false); // back to the form, with the reason
    } finally {
      setBusy(false);
    }
  }

  if (confirming) {
    const host = hostOf(d.url.trim());
    return (
      <Dialog title={`Connect to ${host}?`} onClose={onClose}>
        <div className="col" style={{ gap: 8 }}>
          <p className="small"><strong>Name:</strong> {d.name.trim()}</p>
          <p className="small mcp-command"><strong>Address:</strong> {d.url.trim()}</p>
          <p className="small"><strong>Sign-in:</strong> {d.auth === "oauth" ? "OAuth (you sign in next)" : d.auth === "header" ? `Header ${d.headerName.trim()}` : "None"}</p>
          <p className="lead">
            Our server will connect to this address for you and send it what the AI asks it to do. While it is on, the AI can use its tools whenever <strong>you</strong> ask it something, in any chat, and nothing asks you before each use. Other people in a chat cannot use your servers, but whatever a tool returns goes into that chat, which they can read, and to the AI provider.
          </p>
          <p className="small muted">Your token or sign-in is stored encrypted on our server and used only for your own questions.</p>
        </div>
        {error && <ErrorLine>{error}</ErrorLine>}
        <div className="dialog-actions">
          <Button onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void submit()}>
            Add and connect
          </Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Add a remote MCP server" onClose={onClose}>
      <p className="lead">Our server connects to it for you, so it works in the web and desktop apps. Only give an address you trust: the server sees what the AI sends it, and what it returns goes into the chat.</p>
      <Field label="Name" hint="Letters, digits, - and _. The AI sees its tools as name_tool." htmlFor="rmcp-name">
        <TextInput id="rmcp-name" value={d.name} maxLength={32} onChange={(e) => set({ name: e.target.value })} placeholder="linear" autoFocus />
      </Field>
      <Field label="Address" hint="https only. Addresses on private or internal networks are blocked." htmlFor="rmcp-url">
        <TextInput id="rmcp-url" value={d.url} maxLength={2000} onChange={(e) => set({ url: e.target.value })} placeholder="https://mcp.example.com/mcp" spellCheck={false} />
      </Field>
      <fieldset className="mcp-auth">
        <legend className="field-label">Sign-in</legend>
        <label>
          <input type="radio" name="rmcp-auth" checked={d.auth === "none"} onChange={() => set({ auth: "none" })} /> None
        </label>
        <label>
          <input type="radio" name="rmcp-auth" checked={d.auth === "header"} onChange={() => set({ auth: "header" })} /> Header (API key or token)
        </label>
        {d.auth === "header" && (
          <div className="mcp-header-fields">
            <TextInput aria-label="Header name" value={d.headerName} maxLength={64} onChange={(e) => set({ headerName: e.target.value })} placeholder="Authorization" spellCheck={false} />
            <TextInput aria-label="Header value" type="password" autoComplete="off" value={d.headerValue} maxLength={2000} onChange={(e) => set({ headerValue: e.target.value })} placeholder="Bearer …" />
          </div>
        )}
        {d.auth === "header" && <p className="small muted">Sent with every request. Stored encrypted on our server, write-only: never shown again.</p>}
        <label className={oauthAvailable ? "" : "muted"}>
          <input type="radio" name="rmcp-auth" checked={d.auth === "oauth"} disabled={!oauthAvailable} onChange={() => set({ auth: "oauth" })} /> OAuth (sign in with the provider)
        </label>
        {d.auth === "oauth" && <p className="small muted">After adding, click Sign in and approve on the provider's page.</p>}
        {!oauthAvailable && <p className="small muted">OAuth sign-in is not set up on this chat server.</p>}
      </fieldset>
      {error && <ErrorLine>{error}</ErrorLine>}
      <div className="dialog-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={problem !== null} onClick={() => setConfirming(true)} title={problem ?? undefined}>
          Continue
        </Button>
      </div>
    </Dialog>
  );
}

function ReplaceToken({ server, onClose, onDone }: { server: McpRemoteServer; onClose: () => void; onDone: (s: McpRemoteServer) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.mcpToken(server.id, value));
      onClose();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={`Replace the token for ${server.name}`} onClose={onClose}>
      <Field label={`${server.headerName ?? "Header"} value`} hint="Stored encrypted on our server and never shown again. The old value is replaced." htmlFor="rmcp-token">
        <TextInput id="rmcp-token" type="password" autoComplete="off" value={value} maxLength={2000} onChange={(e) => setValue(e.target.value)} autoFocus />
      </Field>
      {error && <ErrorLine>{error}</ErrorLine>}
      <div className="dialog-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={value === ""} onClick={() => void submit()}>
          Save
        </Button>
      </div>
    </Dialog>
  );
}

/** The "Remote servers" part of the MCP servers tab. */
export function RemoteSection() {
  const { list, error, load, put, add, remove, watchSignIn } = useRemote();
  const [adding, setAdding] = useState(false);
  const [tokenFor, setTokenFor] = useState<McpRemoteServer | null>(null);

  return (
    <section className="col" style={{ gap: 12 }} aria-label="Remote servers">
      <h4 className="mcp-heading">Remote servers</h4>
      <p className="small muted">Run on our server, so they work in the web and desktop apps, even when your computer is off.</p>
      {error && <ErrorLine>{error}</ErrorLine>}
      {list && (
        <div className="settings-rows">
          {list.servers.length === 0 && (
            <div className="setting-row">
              <p className="small muted">No remote servers yet. Nothing is contacted until you add one.</p>
            </div>
          )}
          {list.servers.map((s) => (
            <RemoteRow key={s.id} server={s} oauthAvailable={list.oauthAvailable} onChange={put} onRemove={() => remove(s.id)} onWatch={watchSignIn} onToken={() => setTokenFor(s)} />
          ))}
          <div className="setting-row" style={{ alignItems: "center" }}>
            <p className="small muted grow">{list.servers.length === 0 ? "" : `${list.servers.length} of 10 remote servers`}</p>
            <Button size="sm" onClick={() => setAdding(true)} disabled={list.servers.length >= 10}>
              <Plus size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Add remote server
            </Button>
          </div>
        </div>
      )}
      {adding && list && (
        <AddRemote
          oauthAvailable={list.oauthAvailable}
          onClose={() => setAdding(false)}
          onAdded={(s) => {
            add(s);
            watchSignIn();
            void load();
          }}
        />
      )}
      {tokenFor && <ReplaceToken server={tokenFor} onClose={() => setTokenFor(null)} onDone={(s) => { put(s); watchSignIn(); }} />}
    </section>
  );
}
