import type { ProjectSummary, ScriptInfo, ScriptRun, ScriptsInfo } from "@mc/shared";
import { Copy, Play, Square, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { folderBridge, type ScriptsBridge } from "../lib/folder.ts";
import { openProjectSettings } from "../lib/router.ts";
import { Button, ErrorLine, ICON_SM, STROKE, useToast } from "./kit.tsx";

// The Scripts tab of the Files card: the package.json scripts of the folders this person shares from this computer, each with
// a Run button that turns into Stop while it runs. Run only asks. The request waits in the approval dock and the script starts
// when the owner approves it there and confirms in a window the app itself shows (the same two steps as a command the AI
// proposes, no always-allow). Stop needs no approval. The tab only exists in the desktop app, on the computer that shares the
// folder: scripts run there, with the owner's own rights.

const idOf = (key: string, name: string) => `${key}\n${name}`;

/** "38 s", "2m 14s", "1h 05m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** What the tab's dot shows from outside: green while something runs, red for a crash nobody has looked at. */
export function scriptsDot(info: ScriptsInfo | null): "ready" | "failed" | null {
  if (!info) return null;
  if (info.runs.some((r) => r.state === "run" || r.state === "stopping")) return "ready";
  return info.runs.some((r) => r.unseen) ? "failed" : null;
}

/** Running scripts first, then the ones waiting for approval, then the rest in their own order. A folder with a running script comes first too. */
export function orderScripts(scripts: ScriptInfo[], runs: ScriptRun[]): ScriptInfo[] {
  const rank = (s: ScriptInfo) => {
    const state = runs.find((r) => r.key === s.key && r.name === s.name)?.state;
    return state === "run" || state === "stopping" ? 0 : state === "wait" ? 1 : 2;
  };
  const folderRank = new Map<string, number>();
  for (const s of scripts) folderRank.set(s.folder, Math.min(folderRank.get(s.folder) ?? 2, rank(s)));
  // Array.prototype.sort is stable, so everything else stays in package.json's order (dev, build, test first).
  return [...scripts].sort((a, b) => folderRank.get(a.folder)! - folderRank.get(b.folder)! || rank(a) - rank(b));
}

/** Re-renders every second while `active`, for the running time. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function statusOf(run: ScriptRun | undefined, now: number): string | null {
  if (!run) return null;
  const took = run.startedAt !== null && run.endedAt !== null ? duration(run.endedAt - run.startedAt) : null;
  switch (run.state) {
    case "wait":
      return "Waiting for you to approve…";
    case "run":
      return `Running · ${run.startedAt === null ? "" : duration(now - run.startedAt)}`;
    case "stopping":
      return "Stopping…";
    case "stopped":
      return took ? `Stopped · ran ${took}` : "Stopped";
    case "ok":
      return `Finished · exit 0${took ? ` · ${took}` : ""}`;
    case "crash":
      if (run.note) return run.note;
      return `Crashed${run.exitCode === null ? "" : ` · exit ${run.exitCode}`}${run.endedAt === null ? "" : ` · ${duration(now - run.endedAt)} ago`}`;
  }
}

const dotOf = (state: ScriptRun["state"] | undefined) => (state === "run" || state === "stopping" ? "ready" : state === "crash" ? "failed" : state === "wait" ? "signin" : state ? "" : "off");

export function ScriptsBody({ project, info, version, execOn, bridge }: { project: ProjectSummary; info: ScriptsInfo | null; version: number; execOn: boolean; bridge: ScriptsBridge }) {
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const running = !!info?.runs.some((r) => r.state === "run" || r.state === "crash");
  const now = useNow(running);

  if (!info) return <div className="side-card-body"><p className="small muted">Reading package.json…</p></div>;
  const runOf = (s: ScriptInfo) => info.runs.find((r) => r.key === s.key && r.name === s.name);
  const ordered = orderScripts(info.scripts, info.runs);
  const folders = [...new Set(ordered.map((s) => s.folder))];

  const act = async (s: ScriptInfo, what: "run" | "stop" | "cancel") => {
    setError(null);
    setBusy(idOf(s.key, s.name));
    try {
      if (what === "run") {
        const r = await bridge.run(project.id, s.key, s.name);
        if (!r.ok) setError(r.error);
      } else if (what === "stop") await bridge.stop(project.id, s.key, s.name);
      else await bridge.cancel(project.id, s.key, s.name);
    } catch {
      setError("That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="side-card-body scripts-body">
      {!execOn && (
        <p className="small scripts-off" role="note">
          <TriangleAlert size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Commands are off for this project.{" "}
          <button type="button" className="link-btn" onClick={() => openProjectSettings(project.id)}>
            Turn them on in Project settings
          </button>
        </p>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
      {info.scripts.length === 0 ? (
        <p className="small muted">No scripts to run here. The shared folders have no package.json with scripts.</p>
      ) : (
        <ul className="scripts-list">
          {folders.map((folder) => (
            <li key={folder} className="script-group">
              {folders.length > 1 && <div className="script-group-name">{folder}</div>}
              <ul>
                {ordered
                  .filter((s) => s.folder === folder)
                  .map((s) => {
                    const run = runOf(s);
                    const id = idOf(s.key, s.name);
                    return (
                      <ScriptRow
                        key={id}
                        project={project}
                        script={s}
                        run={run}
                        now={now}
                        version={version}
                        execOn={execOn}
                        busy={busy === id}
                        open={open === id}
                        onToggle={() => setOpen(open === id ? null : id)}
                        onAct={(what) => void act(s, what)}
                        bridge={bridge}
                      />
                    );
                  })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ScriptRow({ project, script, run, now, version, execOn, busy, open, onToggle, onAct, bridge }: { project: ProjectSummary; script: ScriptInfo; run: ScriptRun | undefined; now: number; version: number; execOn: boolean; busy: boolean; open: boolean; onToggle: () => void; onAct: (what: "run" | "stop" | "cancel") => void; bridge: ScriptsBridge }) {
  const state = run?.state;
  const status = statusOf(run, now);
  return (
    <li className={`script-item ${state ?? "idle"}`}>
      <div className="script-row">
        <button type="button" className="script-main" aria-expanded={open} aria-label={`${script.name}: ${open ? "hide" : "show"} the log`} onClick={onToggle}>
          <span className={`mdot ${dotOf(state)}`} aria-hidden />
          <span className="script-text">
            <b className="truncate">{script.name}</b>
            {status ? <span className={`script-status truncate ${state === "crash" ? "bad" : state === "run" ? "good" : ""}`}>{status}</span> : <code className="script-body truncate" title={script.body}>{script.body}</code>}
          </span>
        </button>
        {state === "run" || state === "stopping" ? (
          <Button size="sm" variant="primary" busy={state === "stopping" || busy} disabled={state === "stopping"} onClick={() => onAct("stop")} aria-label={`Stop ${script.name}`}>
            <Square size={ICON_SM} strokeWidth={STROKE} aria-hidden fill="currentColor" /> Stop
          </Button>
        ) : state === "wait" ? (
          <Button size="sm" onClick={() => onAct("cancel")} aria-label={`Cancel running ${script.name}`}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" disabled={!execOn || busy} busy={busy} onClick={() => onAct("run")} aria-label={`Run ${script.name}: ${script.command}`}>
            <Play size={ICON_SM} strokeWidth={STROKE} aria-hidden /> {state === "crash" ? "Run again" : "Run"}
          </Button>
        )}
      </div>
      {open && <ScriptLog project={project} script={script} run={run} version={version} bridge={bridge} />}
    </li>
  );
}

/** The log of one script, under its row: live while it runs, kept after it ends until it runs again or is cleared. */
function ScriptLog({ project, script, run, version, bridge }: { project: ProjectSummary; script: ScriptInfo; run: ScriptRun | undefined; version: number; bridge: ScriptsBridge }) {
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const [atEnd, setAtEnd] = useState(true);
  const box = useRef<HTMLPreElement>(null);
  const live = run?.state === "run" || run?.state === "stopping";

  useEffect(() => {
    let current = true;
    void bridge.log(project.id, script.key, script.name).then((t) => current && setText(t), () => undefined);
    return () => {
      current = false;
    };
  }, [bridge, project.id, script.key, script.name, version]);

  // Follows the end of the log, unless the person scrolled up to read.
  useEffect(() => {
    const el = box.current;
    if (el && atEnd) el.scrollTop = el.scrollHeight;
  }, [text, atEnd]);

  const copy = () =>
    void navigator.clipboard?.writeText(text ?? "").then(
      () => toast.push("Log copied"),
      () => toast.push("Couldn't copy the log"),
    );

  return (
    <div className="script-log">
      <pre
        ref={box}
        tabIndex={0}
        aria-label={`Log of ${script.name}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
      >
        {text ? text : <span className="muted">{run ? "No output yet." : "Not run yet."}</span>}
      </pre>
      {run?.state === "crash" && (
        <p className="small script-crash" role="note">
          {run.note ?? `Exited with code ${run.exitCode ?? "?"}. Run again to retry.`}
        </p>
      )}
      <div className="script-log-actions">
        {!atEnd && (
          <button type="button" className="link-btn small" onClick={() => setAtEnd(true)}>
            Jump to latest
          </button>
        )}
        <span className="grow small muted">{live ? "Live" : ""}</span>
        <Button size="sm" variant="ghost" disabled={!text} onClick={copy}>
          <Copy size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Copy
        </Button>
        <Button size="sm" variant="ghost" disabled={live || !text} onClick={() => void bridge.clear(project.id, script.key, script.name)}>
          Clear
        </Button>
      </div>
    </div>
  );
}

/** Whether this app can run scripts (desktop, new enough). */
export const scriptsBridge = (): ScriptsBridge | null => folderBridge()?.scripts ?? null;
