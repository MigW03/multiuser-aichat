import { classifyCommand, RISKY_FILE, type ChangePreview } from "@mc/shared";
import { Check, FilePen, FilePlus, GitBranch, Hourglass, Maximize2, Minimize2, ShieldCheck, Terminal, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { folderBridge, useAutoRan, useHostApprovals, type AutoRan, type PendingChange } from "../lib/folder.ts";
import { createPortal } from "react-dom";
import { Button, ICON_SM, IconButton, STROKE } from "./kit.tsx";
import type { Proposal } from "./useChatRoom.ts";

// AI changes to the shared files. Everybody in the chat sees what the AI proposes (a diff). Only the person who shares the files decides, and
// only in the desktop app on the computer that holds the files: the dock below is the one place with buttons, and it
// is fed by the app itself, not by the chat server, so a message in the chat can't make a change look different.

/** A unified diff, one line per row, added and removed lines tinted. Text only: nothing in a diff is rendered as markup. */
export function DiffView({ diff, cut }: { diff: string; cut?: boolean }) {
  // The lines between "diff --git" and the first "@@" are git's file header (index, ---, +++), not changes.
  let header = false;
  return (
    <pre className="diff" tabIndex={0}>
      {/* One inner block as wide as the longest line, so every row's tint spans the full scroll width. */}
      <span className="diff-lines">
        {diff.split("\n").map((line, i) => {
          if (line.startsWith("diff --git")) header = true;
          else if (line.startsWith("@@")) header = false;
          const kind = header || line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
          const marker = kind === "add" || kind === "del" || (kind === "" && line.startsWith(" ")) ? line[0]! : "";
          return (
            <span key={i} className={`dl ${kind}`}>
              {/* the +/- stays at the left edge while the text scrolls */}
              <span className="mk" aria-hidden>{marker || " "}</span>
              <span className="tx">{marker ? line.slice(1) : line}{"\n"}</span>
            </span>
          );
        })}
        {cut && (
          <span className="dl hunk">
            <span className="mk" aria-hidden> </span>
            <span className="tx">The diff is cut here; the full change is applied if approved.{"\n"}</span>
          </span>
        )}
      </span>
    </pre>
  );
}

/** An approved-or-not command, shown as text. The warnings are only hints from a pattern list: the host reads the command. */
function CommandBlock({ change, warn }: { change: ChangePreview; warn: boolean }) {
  // A script's warnings come from what it runs (its body and hooks), not only from `npm run dev`.
  const flags = warn ? classifyCommand([change.command ?? "", change.script?.body ?? "", ...(change.script?.around ?? [])].join("\n")) : [];
  return (
    <>
      <pre className="git-command exec-command">{change.command}</pre>
      <p className="small muted exec-facts">
        In {change.workdir ? <b>{change.workdir}</b> : "the shared folder"} · {change.script ? "runs until you stop it" : <>stops after {change.timeoutSec ?? 120} s</>}
        {change.script ? <> · the script runs: <code>{change.script.body}</code></> : null}
        {change.note ? <> · the AI says: <i>{change.note}</i></> : null}
      </p>
      {change.script?.around?.map((a) => (
        <p key={a} className="small muted exec-facts">
          Also runs <code>{a}</code>
        </p>
      ))}
      {flags.map((f) => (
        <p key={f.kind} className="small risky" role="note">
          <TriangleAlert size={ICON_SM} strokeWidth={STROKE} aria-hidden /> {f.label}.
        </p>
      ))}
    </>
  );
}

function Stats({ change }: { change: ChangePreview }) {
  if (change.kind === "exec") return null;
  return (
    <span className="diff-stats small">
      <span className="add">+{change.added}</span> <span className="del">−{change.removed}</span>
    </span>
  );
}

const OUTCOME: Record<NonNullable<Proposal["outcome"]>, string> = {
  applied: "Approved and written",
  denied: "Declined by the owner",
  expired: "Not approved in time",
  failed: "Not written",
};

/** What the people in the chat see while the answer is being written: each change the AI proposed, and how it ended. */
export function ProposalCards({ proposals }: { proposals: Proposal[] }) {
  if (proposals.length === 0) return null;
  return (
    <div className="proposals">
      {proposals.map((p) => (
        <details key={p.change.id} className={`proposal ${p.outcome ?? "waiting"}`} open={!p.outcome}>
          <summary>
            {p.change.kind === "exec" ? <Terminal size={ICON_SM} strokeWidth={STROKE} aria-hidden /> : p.change.kind === "git" ? <GitBranch size={ICON_SM} strokeWidth={STROKE} aria-hidden /> : p.change.created ? <FilePlus size={ICON_SM} strokeWidth={STROKE} aria-hidden /> : <FilePen size={ICON_SM} strokeWidth={STROKE} aria-hidden />}
            <span className="grow truncate">
              <b>{p.change.path}</b> {p.change.kind === "git" || p.change.kind === "exec" ? "" : p.change.created ? "(new file)" : ""}
            </span>
            <Stats change={p.change} />
            <span className={`chip ${p.outcome === "applied" ? "accent" : ""}`}>
              {p.outcome ? (p.outcome === "applied" && p.change.auto ? (p.change.kind === "exec" ? "Ran without asking" : "Saved without asking") : p.outcome === "applied" && (p.change.kind === "git" || p.change.kind === "exec") ? "Approved and run" : OUTCOME[p.outcome]) : (
                <>
                  <Hourglass size={12} strokeWidth={STROKE} aria-hidden /> Waiting for the owner
                </>
              )}
            </span>
          </summary>
          {p.change.kind === "exec" ? (
            <CommandBlock change={p.change} warn />
          ) : (
            <>
              {p.change.command && <code className="git-command">{p.change.command}</code>}
              <DiffView diff={p.change.diff} cut={p.change.cut} />
            </>
          )}
        </details>
      ))}
    </div>
  );
}

function minutesLeft(at: number, now: number) {
  const s = Math.max(0, Math.ceil((at - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** How one waiting change is shown. Changing it never decides anything: only the Approve and Decline buttons do. */
type View = "small" | "expanded" | "hidden";

function PendingCard({ item, projectName, view, setView }: { item: PendingChange; projectName: string; view: View; setView: (v: View) => void }) {
  const bridge = folderBridge();
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [now, setNow] = useState(Date.now());
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const expanded = view === "expanded";
  useEffect(() => {
    if (!expanded) return;
    // Focus the window itself, not a button: pressing Enter must never approve by accident.
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setView("small");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, setView]);

  async function decide(approve: boolean) {
    if (!bridge?.decide) return;
    setBusy(approve ? "approve" : "deny");
    try {
      await bridge.decide(item.projectId, item.id, approve);
    } finally {
      setBusy(null);
    }
  }

  const c = item.change;
  const left = minutesLeft(item.expiresAt, now);

  // Closed from the big window: nothing is decided and the timer keeps running; a small tab brings it back.
  if (view === "hidden") {
    return (
      <button type="button" className="dock-pill" onClick={() => setView("small")} aria-label={`Show the change to ${c.path}, ${left} left`}>
        <ShieldCheck size={ICON_SM} strokeWidth={STROKE} aria-hidden />
        <span className="truncate">Change waiting: {c.path}</span>
        <span className="muted small">{left}</span>
      </button>
    );
  }

  const card = (
    <section
      ref={dialogRef}
      className={`dock-card ${expanded ? "expanded" : ""}`}
      aria-label={`Change to ${c.path}`}
      {...(expanded ? { role: "dialog", "aria-modal": true, tabIndex: -1 } : {})}
    >
      <header>
        <ShieldCheck size={ICON_SM} strokeWidth={STROKE} aria-hidden />
        <span className="grow">
          {c.script ? (
            <>You asked to run the script <b>{c.script.name}</b></>
          ) : (
            <>
              <b>{item.askedBy}</b>'s AI wants to {c.kind === "exec" ? <b>run a command</b> : <>{c.kind === "git" ? "run" : c.created ? "create" : "change"} <b>{c.path}</b></>}
            </>
          )}{" "}
          in {projectName}
        </span>
        <Stats change={c} />
        {expanded ? (
          <>
            <IconButton label="Minimize to the small window" className="sm" onClick={() => setView("small")}>
              <Minimize2 size={ICON_SM} strokeWidth={STROKE} />
            </IconButton>
            <IconButton label="Close this window (nothing is approved or declined)" className="sm" onClick={() => setView("hidden")}>
              <X size={ICON_SM} strokeWidth={STROKE} />
            </IconButton>
          </>
        ) : (
          <IconButton label="Expand" className="sm" onClick={() => setView("expanded")}>
            <Maximize2 size={ICON_SM} strokeWidth={STROKE} />
          </IconButton>
        )}
      </header>
      {item.reason && (
        <p className="small ask-reason" role="note">
          {item.reason}
          {c.kind === "exec" && item.unreviewed && item.unreviewed.length > 0 ? " Approving this command marks them reviewed: checks run without asking again until the AI saves another file." : ""}
        </p>
      )}
      {c.kind === "exec" ? (
        <CommandBlock change={c} warn />
      ) : (
        <>
          {c.command && <code className="git-command">{c.command}</code>}
          {c.destructive && (
            <p className="small risky" role="note">
              <TriangleAlert size={ICON_SM} strokeWidth={STROKE} aria-hidden /> This throws away uncommitted changes. They cannot be brought back. The diff below is what would be lost.
            </p>
          )}
          {c.kind !== "git" && RISKY_FILE.test(c.path) && (
            <p className="small risky" role="note">
              This file can run code when the project is built, installed or pushed. Read the whole diff before approving.
            </p>
          )}
          <DiffView diff={c.diff} cut={c.cut} />
        </>
      )}
      <p className="small muted">
        {c.script
          ? `It runs in the background with your own rights, and nothing limits what it can read or change. Approving opens a second window where you confirm. Nothing runs until you do. You can stop it any time in the Scripts tab. Time left: ${left}.`
          : c.kind === "exec"
          ? `It read ${item.readFiles} ${item.readFiles === 1 ? "file" : "files"} before proposing this. It runs with your own rights, and nothing limits what it can read or change. Approving opens a second window where you confirm. Nothing runs until you do. Time left: ${left}.`
          : `It read ${item.readFiles} ${item.readFiles === 1 ? "file" : "files"} before proposing this. Check that the change is what was asked for. Nothing ${c.kind === "git" ? "runs" : "is written"} until you approve. Time left: ${left}.`}
      </p>
      {c.kind === "exec" && item.canAlwaysAllow && (
        <p className="small muted">In the next window you can choose to always allow this exact {c.script ? "script" : "command"} in this folder.</p>
      )}
      <div className="row dock-actions">
        <Button size="sm" variant="primary" busy={busy === "approve"} disabled={busy !== null} onClick={() => void decide(true)}>
          <Check size={ICON_SM} strokeWidth={STROKE} aria-hidden /> {c.kind === "exec" ? "Review and run…" : c.kind === "git" ? "Approve and run" : "Approve and write"}
        </Button>
        <Button size="sm" busy={busy === "deny"} disabled={busy !== null} onClick={() => void decide(false)}>
          <X size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Decline
        </Button>
      </div>
    </section>
  );
  // The big window sits over the app, centered. The backdrop does nothing when clicked.
  return expanded ? createPortal(<div className="dock-backdrop">{card}</div>, document.body) : card;
}

/** Something that just happened without asking: a command a rule matched or the owner let through, or an edit saved. Shown so it never happens unseen. */
function AutoRanRow({ ran, projectName, dismiss }: { ran: AutoRan; projectName: string; dismiss: () => void }) {
  const allow = folderBridge()?.allow;
  const [error, setError] = useState<string | null>(null);
  async function revoke() {
    if (!allow || !ran.ruleId) return;
    try {
      if (await allow.revoke(ran.projectId, ran.ruleId)) dismiss();
      else setError("It was already revoked or has expired.");
    } catch {
      setError("Could not revoke it.");
    }
  }
  const edit = ran.kind === "edit";
  return (
    <section className="dock-card dock-ran" aria-label={edit ? "A file was saved without asking" : "A command ran without asking"}>
      <header>
        {edit ? <FilePen size={ICON_SM} strokeWidth={STROKE} aria-hidden /> : <Terminal size={ICON_SM} strokeWidth={STROKE} aria-hidden />}
        <span className="grow">
          {edit ? (
            <>
              {ran.ok ? "Saved" : "Tried to save"} without asking: <code>{ran.path}</code> <span className="diff-stats small"><span className="add">+{ran.added ?? 0}</span> <span className="del">−{ran.removed ?? 0}</span></span>
              <span className="muted"> · {projectName}</span>
            </>
          ) : (
            <>
              {ran.ok ? "Ran" : "Tried to run"} without asking: <code>{ran.command}</code>
              <span className="muted"> · {ran.folder || projectName}</span>
            </>
          )}
        </span>
        {ran.ruleId && (
          <Button size="sm" onClick={() => void revoke()}>
            Revoke
          </Button>
        )}
        <IconButton label="Dismiss" className="sm" onClick={dismiss}>
          <X size={ICON_SM} strokeWidth={STROKE} />
        </IconButton>
      </header>
      <p className="small muted">
        {edit
          ? `The AI's edit was saved at once because you chose that for ${projectName}. Change this in Project settings.`
          : ran.kind
            ? `A safe command, run at once because you chose that for ${projectName}. Change this in Project settings.`
            : `You always allowed this exact command in ${projectName}. Revoke makes it ask every time again.`}
      </p>
      {error && <p className="small risky">{error}</p>}
    </section>
  );
}

/** The host's approval panel (desktop app only). Shows every change waiting on this computer, whichever chat it came from. */
export function ApprovalDock({ projectName }: { projectName: (id: string) => string }) {
  const pending = useHostApprovals();
  const ran = useAutoRan();
  const [views, setViews] = useState<Record<string, View>>({});
  if (pending.length === 0 && ran.rows.length === 0) return null;
  const keyOf = (p: PendingChange) => `${p.projectId}:${p.id}`;
  return (
    <aside className="approval-dock" role="region" aria-label="AI changes waiting for you" aria-live="polite">
      {pending.map((item) => (
        <PendingCard
          key={keyOf(item)}
          item={item}
          projectName={projectName(item.projectId)}
          view={views[keyOf(item)] ?? "small"}
          setView={(v) => setViews((cur) => ({ ...cur, [keyOf(item)]: v }))}
        />
      ))}
      {ran.rows.map((r) => (
        <AutoRanRow key={r.id} ran={r} projectName={projectName(r.projectId)} dismiss={() => ran.dismiss(r.id)} />
      ))}
    </aside>
  );
}
