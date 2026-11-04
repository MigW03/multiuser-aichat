import { readValue, type PanelFull, type PanelSource, type SourceNeed, type SourceRead } from "@mc/shared";
import { BuiltinActionType, Renderer, type ActionEvent } from "@openuidev/react-lang";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { useApp } from "../data.tsx";
import { BlockBoundary, safeUrl } from "../genui/GeneratedAnswer.tsx";
import { GenTextContext } from "../genui/library.tsx";
import { panelLibrary, PanelDataContext, type PanelData, type SourceState } from "../genui/panel-library.tsx";
import { copyText } from "../lib/actions.ts";
import { draftInOpenChat } from "../lib/drafts.ts";
import { cleanState, panelsBridge } from "../lib/panels.ts";
import { draftFromAction } from "@mc/shared";
import { Button, Dialog, ErrorLine, useToast } from "./kit.tsx";
import { Markdown } from "./Markdown.tsx";

// The body of one custom panel: the AI's wireframe drawn from the app's own pieces, with the person's ticks and notes kept on
// this computer and numbers read from their own connected services. Nothing here runs code from the panel. The header, the tab
// and the "..." menu around it are Nido's own.

const SAVE_MS = 600;
/** Reads one at a time: the tool servers answer a few calls at once at most. */
const SPACING_MS = 0;

const markdownText = (text: string) => <Markdown text={text} />;

async function readSource(projectId: string, panelId: string, src: PanelSource): Promise<SourceRead> {
  const bridge = panelsBridge();
  const retry: SourceRead = { ok: false, need: "retry", server: src.server };
  if (!bridge) return retry;
  const local = await bridge.readSource(projectId, panelId, src.id);
  if (!local.ok) return retry;
  if (local.value) return local.value;
  // Not a server on this computer: one of the person's remote servers, which the chat server calls for them.
  return api.mcpRead({ server: src.server, tool: src.tool, args: src.args });
}

export function PanelBody({ projectId, panel, refreshToken = 0 }: { projectId: string; panel: PanelFull; /** Changes when the person presses refresh. */ refreshToken?: number }) {
  // A new version is a new body: its saved data was loaded with it.
  return <Inner key={`${panel.meta.id}:${panel.meta.rev}`} projectId={projectId} panel={panel} refreshToken={refreshToken} />;
}

function Inner({ projectId, panel, refreshToken }: { projectId: string; panel: PanelFull; refreshToken: number }) {
  const toast = useToast();
  const app = useApp();
  const { meta } = panel;
  const initial = useRef(panel.state);
  const [sources, setSources] = useState<Record<string, SourceState>>(() => Object.fromEntries(meta.sources.map((s) => [s.id, { label: s.label, status: "loading" as const }])));
  const [connect, setConnect] = useState<{ server: string } | null>(null);
  const [again, setAgain] = useState(0);

  // ---- data: on open and when the person presses refresh, never in the background
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const src of meta.sources) {
        let next: SourceState;
        try {
          const r = await readSource(projectId, meta.id, src);
          next = r.ok ? { label: src.label, status: "ok", value: readValue(r.text), truncated: r.truncated, at: Date.now() } : { label: src.label, status: "need", need: r.need, server: r.server };
        } catch {
          // offline or the chat server is away: what was shown before stays, greyed
          next = { label: src.label, status: "need", need: "retry", server: src.server };
          setSources((all) => {
            const old = all[src.id];
            return live && old?.status === "ok" ? { ...all, [src.id]: { ...old, stale: true } } : live ? { ...all, [src.id]: next } : all;
          });
          continue;
        }
        if (!live) return;
        setSources((all) => ({ ...all, [src.id]: next }));
        if (SPACING_MS) await new Promise((r) => setTimeout(r, SPACING_MS));
      }
    })();
    return () => {
      live = false;
    };
  }, [projectId, meta.id, meta.sources, refreshToken, again]);

  // ---- what the person ticks and types: saved on this computer, a moment after the last change
  const latest = useRef<Record<string, unknown> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const told = useRef(false);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const state = latest.current;
    latest.current = null;
    const bridge = panelsBridge();
    if (!state || !bridge) return;
    void bridge.saveState(projectId, meta.id, cleanState(state)).then((r) => {
      if (!r.ok && !told.current) {
        told.current = true;
        toast.push(r.error, "error");
      }
    });
  }, [projectId, meta.id, toast]);
  useEffect(() => flush, [flush]); // leaving the panel saves what is waiting
  const onStateUpdate = useCallback(
    (state: Record<string, unknown>) => {
      latest.current = state;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_MS);
    },
    [flush],
  );

  // ---- clicks in the panel: only ever a draft in the chat box, a link, or a copy
  const draft = useCallback(
    (text: string) => {
      if (!draftInOpenChat(text)) void copyText(text).then((ok) => toast.push(ok ? "Copied. Open a chat to paste it" : "Could not copy", "info"));
    },
    [toast],
  );
  const onAction = useCallback(
    (event: ActionEvent) => {
      if (event.type === BuiltinActionType.ContinueConversation) {
        const text = draftFromAction(event.humanFriendlyMessage, event.formState, event.formName, event.params?.context);
        if (text) draft(text);
      } else if (event.type === BuiltinActionType.OpenUrl) {
        const url = safeUrl(event.params?.url);
        if (url) window.open(url, "_blank", "noopener,noreferrer");
        else toast.push("That link can't be opened", "error");
      } else if (event.type === "CopyText") {
        const copied = String(event.params?.text ?? "").slice(0, 20_000);
        void copyText(copied).then((ok) => toast.push(ok ? "Copied" : "Could not copy", "info"));
      }
    },
    [draft, toast],
  );

  const data: PanelData = useMemo(
    () => ({
      sources,
      act: {
        askToFix: (text) => draft(`${text}`),
        fix: (need: SourceNeed, server: string) => {
          if (need === "setup") app.openSettings("mcp");
          else if (need === "signin") setConnect({ server });
          else setAgain((n) => n + 1);
        },
      },
    }),
    [sources, app, draft],
  );

  return (
    <GenTextContext.Provider value={markdownText}>
      <PanelDataContext.Provider value={data}>
        <BlockBoundary fallback={<div className="gen-need">This panel couldn't be drawn.</div>}>
          <div className="gen-block panel-body">
            <Renderer library={panelLibrary} response={panel.view} initialState={initial.current} onStateUpdate={onStateUpdate} onAction={onAction} onError={() => undefined} />
          </div>
        </BlockBoundary>
        {connect && <ConnectSheet panelName={meta.name} sources={meta.sources.filter((s) => s.server === connect.server)} server={connect.server} onClose={() => setConnect(null)} onSignedIn={() => setAgain((n) => n + 1)} />}
      </PanelDataContext.Provider>
    </GenTextContext.Provider>
  );
}

/** Nido's own sheet for signing in a service the panel reads from. The panel never sees the sign-in. */
function ConnectSheet({ panelName, server, sources, onClose, onSignedIn }: { panelName: string; server: string; sources: PanelSource[]; onClose: () => void; onSignedIn: () => void }) {
  const app = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const row = (await api.mcpServers()).servers.find((s) => s.name === server);
      if (!row) {
        onClose();
        app.openSettings("mcp");
        return;
      }
      if (row.authKind !== "oauth") {
        // A key or token the person typed in: replacing it happens in Settings, not in the panel.
        onClose();
        app.openSettings("mcp", row.name);
        return;
      }
      const { url } = await api.mcpSignIn(row.id);
      if (url) window.open(url, "_blank", "noopener,noreferrer"); // the desktop app hands https pages to the system browser
      onClose();
      toast.push(`Finish signing in to ${server} in your browser`, "info");
      // Look again every few seconds for two minutes: the data fills in once the sign-in is done.
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 5_000));
        const now = (await api.mcpServers().catch(() => null))?.servers.find((s) => s.name === server);
        if (now?.status === "ready") {
          onSignedIn();
          toast.push(`${server} connected`, "info");
          return;
        }
      }
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Could not start the sign-in. Try again.");
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Connect ${server} for “${panelName}”?`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => void go()}>
            Continue
          </Button>
        </>
      }
    >
      <p className="small">
        This panel will read: {sources.map((s) => s.purpose).join("; ") || "data from this service"}. Read-only. The panel never sees your sign-in.
      </p>
      {error && <ErrorLine>{error}</ErrorLine>}
    </Dialog>
  );
}
