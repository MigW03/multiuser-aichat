import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { mcpBridge, useMcp, type McpInfo, type McpServer } from "../lib/folder.ts";
import { Button, Dialog, ErrorLine, Field, ICON_SM, STROKE, TextInput } from "./kit.tsx";
import { RemoteSection } from "./RemoteMcp.tsx";

// MCP servers in the app's Settings (account menu, bottom left). They belong to the signed-in person. Local ones run on
// their computer, started by the desktop app (this file); remote ones are called by the chat server (RemoteMcp.tsx). Adding one shows its exact command in a window the app opens itself; once a
// server is on, the AI uses its tools for the answers this person asks for, without asking each time.

const STATUS: Record<McpServer["status"], string> = { off: "Off", starting: "Starting…", ready: "Running", failed: "Failed" };
const LINK: Record<McpInfo["link"], string> = { off: "Not connected", connecting: "Connecting…", connected: "Connected to the chat", auth: "Sign-in needs refreshing" };

/** The tools a running server offers, each with a switch for the AI. Shared by local and remote servers. */
export function ToolList({ tools, busy, onToggle }: { tools: { name: string; description: string; enabled: boolean; usable: boolean; note?: string }[]; busy: boolean; onToggle: (tool: string, on: boolean) => void }) {
  return (
    <ul className="mcp-tools">
      {tools.map((t) => (
        <li key={t.name}>
          <input type="checkbox" className="setting-switch" role="switch" aria-label={`${t.name} on for the AI`} checked={t.usable && t.enabled} disabled={busy || !t.usable} onChange={(e) => onToggle(t.name, e.target.checked)} />
          <div className="grow">
            <div className="strong mcp-tool-name">{t.name}</div>
            <p className="small muted">{t.note ?? (t.description || "No description.")}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ServerRow({ server, onInfo }: { server: McpServer; onInfo: (i: McpInfo) => void }) {
  const bridge = mcpBridge()!;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<McpInfo>) => {
    setBusy(true);
    try {
      onInfo(await f());
    } catch {
      /* the list refreshes by itself when the app reports a change */
    } finally {
      setBusy(false);
    }
  };
  const usable = server.tools.filter((t) => t.usable);
  return (
    <div className="setting-row mcp-server">
      <div className="grow">
        <div className="strong">
          {server.name} <span className={`mcp-status ${server.status}`}>{STATUS[server.status]}</span>
          {server.status === "ready" && (
            <span className="small muted">
              {" "}
              · {usable.filter((t) => t.enabled).length} of {usable.length} tools on for the AI
            </span>
          )}
        </div>
        <p className="small muted mcp-command" title={server.command}>
          {server.command}
        </p>
        {server.envKeys.length > 0 && <p className="small muted">Environment: {server.envKeys.join(", ")} (values stay on this computer)</p>}
        {server.error && <p className="small mcp-error">{server.error}</p>}
        <div className="mcp-actions">
          {server.status === "failed" && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => bridge.retry(server.name))}>
              <RotateCcw size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Try again
            </Button>
          )}
          {server.tools.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? "Hide tools" : "Show tools"}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => bridge.remove(server.name))}>
            <Trash2 size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Remove
          </Button>
        </div>
        {open && (
          <ToolList tools={server.tools} busy={busy} onToggle={(tool, on) => void run(() => bridge.setTool(server.name, tool, on))} />
        )}
      </div>
      <input
        type="checkbox"
        className="setting-switch"
        role="switch"
        aria-label={`${server.name} on`}
        checked={server.enabled}
        disabled={busy}
        onChange={(e) => void run(() => bridge.setServer(server.name, e.target.checked))}
      />
    </div>
  );
}

function AddServer({ onClose, onInfo }: { onClose: () => void; onInfo: (i: McpInfo) => void }) {
  const bridge = mcpBridge()!;
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [env, setEnv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // The app shows the exact command in its own window; this resolves when the person has decided there.
      const r = await bridge.add({ name: name.trim(), command, env });
      if (r.ok) {
        onInfo(r.info);
        onClose();
      } else if (r.error) setError(r.error);
    } catch {
      setError("Could not add the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Add an MCP server" onClose={onClose}>
      <p className="lead">
        An MCP server is a program this app starts on your computer; it gives the AI tools. You confirm the exact command in a separate window next. Once it runs, the AI can use its tools whenever you ask it something, without asking you each time.
      </p>
      <Field label="Name" hint="Letters, digits, - and _. The AI sees its tools as name_tool." htmlFor="mcp-name">
        <TextInput id="mcp-name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="github" autoFocus />
      </Field>
      <Field label="Command" hint="The program and its arguments, like: npx -y @modelcontextprotocol/server-github. Use quotes around anything with spaces. Keys and tokens go under Environment, not here: the command is saved and shown as typed." htmlFor="mcp-command">
        <TextInput id="mcp-command" value={command} maxLength={2500} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y some-mcp-server" spellCheck={false} />
      </Field>
      <Field label="Environment (optional)" hint="One KEY=value per line, for API keys the server needs. Stored encrypted on this computer only." htmlFor="mcp-env">
        <textarea id="mcp-env" className="input mcp-env" rows={3} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="API_KEY=…" spellCheck={false} autoComplete="off" />
      </Field>
      {error && <ErrorLine>{error}</ErrorLine>}
      <div className="dialog-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!name.trim() || !command.trim()} onClick={() => void submit()}>
          Continue
        </Button>
      </div>
    </Dialog>
  );
}

/** The local servers: programs the desktop app starts on this computer. Desktop only. */
function LocalSection() {
  const bridge = mcpBridge();
  const { info, set } = useMcp();
  const [adding, setAdding] = useState(false);
  return (
    <section className="col" style={{ gap: 12 }} aria-label="On this computer">
      <h4 className="mcp-heading">On this computer</h4>
      {!bridge ? (
        <div className="settings-rows">
          <div className="setting-row">
            <p className="small muted">Servers that run as programs on your computer are set up in the <strong>desktop app</strong>. The AI can use them for answers you ask for in the web app only while your desktop app is open and signed in.</p>
          </div>
        </div>
      ) : (
        info && (
          <>
            <div className="small muted mcp-link">
              <span className={`mcp-dot ${info.link}`} aria-hidden /> {LINK[info.link]}
              {info.link !== "connected" && " · the AI can use these tools only while this app is open and connected."}
            </div>
            <div className="settings-rows">
              {info.servers.length === 0 && (
                <div className="setting-row">
                  <p className="small muted">No servers on this computer yet. Nothing runs until you add one.</p>
                </div>
              )}
              {info.servers.map((s) => (
                <ServerRow key={s.name} server={s} onInfo={set} />
              ))}
              <div className="setting-row" style={{ alignItems: "center" }}>
                <p className="small muted grow">{info.servers.length === 0 ? "" : `${info.servers.length} of 10 local servers`}</p>
                <Button size="sm" onClick={() => setAdding(true)} disabled={info.servers.length >= 10}>
                  <Plus size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Add local server
                </Button>
              </div>
            </div>
            {adding && <AddServer onClose={() => setAdding(false)} onInfo={set} />}
          </>
        )
      )}
    </section>
  );
}

/** The "MCP servers" tab of Settings: remote servers (everywhere) and servers on this computer (desktop). */
export function McpTab() {
  return (
    <div className="col" style={{ gap: 20 }}>
      <h3 className="dialog-title flush">MCP servers</h3>
      <p className="small muted">
        MCP servers give the AI extra tools (look things up, call a service). The AI uses them only when <strong>you</strong> ask it something, in any chat, and picks the fitting tool on its own. Nobody else can use your servers, but what a tool returns shows up in the chat, so everyone in that chat can read it.
      </p>
      <RemoteSection />
      <LocalSection />
    </div>
  );
}
