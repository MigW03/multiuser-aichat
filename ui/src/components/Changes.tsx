import type { ChangePreview } from "@mc/shared";
import { Check, FilePen, FilePlus, Hourglass, Maximize2, Minimize2, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { folderBridge, useHostApprovals, type PendingChange } from "../lib/folder.ts";
import { createPortal } from "react-dom";
import { Button, ICON_SM, IconButton, STROKE } from "./kit.tsx";
import type { Proposal } from "./useChatRoom.ts";

// AI changes to the shared files. Everybody in the chat sees what the AI proposes (a diff). Only the host decides, and
// only in the desktop app on the computer that holds the files: the dock below is the one place with buttons, and it
// is fed by the app itself, not by the chat server, so a message in the chat can't make a change look different.

/** A unified diff, one line per row, added and removed lines tinted. Text only: nothing in a diff is rendered as markup. */
export function DiffView({ diff, cut }: { diff: string; cut?: boolean }) {
  return (
    <pre className="diff" tabIndex={0}>
      {/* One inner block as wide as the longest line, so every row's tint spans the full scroll width. */}
      <span className="diff-lines">
        {diff.split("\n").map((line, i) => {
          const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "";
          const marker = kind === "add" || kind === "del" || (kind === "" && line.startsWith(" ")) ? line[0]! : "";
          return (
            <span key={i} className={`dl ${kind}`}>
              {/* the +/- stays at the left edge while the text scrolls */}
              <span className="mk" aria-hidden>{marker || " "}</span>
              <span className="tx">{marker || kind === "hunk" ? line.slice(marker ? 1 : 0) : line}{"\n"}</span>
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

/** Files that run code when a project is built, installed, committed or pushed. A change there deserves a slower look. */
const RISKY = /(^|\/)(\.github\/|\.gitlab-ci|\.vscode\/|\.husky\/|package\.json$|Makefile$|Dockerfile|[^/]+\.(sh|bash|zsh|bat|cmd|ps1)$|pre-commit$|pre-push$)/i;

function Stats({ change }: { change: ChangePreview }) {
  return (
    <span className="diff-stats small">
      <span className="add">+{change.added}</span> <span className="del">−{change.removed}</span>
    </span>
  );
}

const OUTCOME: Record<NonNullable<Proposal["outcome"]>, string> = {
  applied: "Approved and written",
  denied: "Declined by the host",
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
            {p.change.created ? <FilePlus size={ICON_SM} strokeWidth={STROKE} aria-hidden /> : <FilePen size={ICON_SM} strokeWidth={STROKE} aria-hidden />}
            <span className="grow truncate">
              <b>{p.change.path}</b> {p.change.created ? "(new file)" : ""}
            </span>
            <Stats change={p.change} />
            <span className={`chip ${p.outcome === "applied" ? "accent" : ""}`}>
              {p.outcome ? OUTCOME[p.outcome] : (
                <>
                  <Hourglass size={12} strokeWidth={STROKE} aria-hidden /> Waiting for the host
                </>
              )}
            </span>
          </summary>
          <DiffView diff={p.change.diff} cut={p.change.cut} />
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
          <b>{item.askedBy}</b>'s AI wants to {c.created ? "create" : "change"} <b>{c.path}</b> in {projectName}
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
      {RISKY.test(c.path) && (
        <p className="small risky" role="note">
          This file can run code when the project is built, installed or pushed. Read the whole diff before approving.
        </p>
      )}
      <DiffView diff={c.diff} cut={c.cut} />
      <p className="small muted">
        It read {item.readFiles} {item.readFiles === 1 ? "file" : "files"} before proposing this. Check that the change is what was asked for. Nothing is written until you approve. Time left: {left}.
      </p>
      <div className="row dock-actions">
        <Button size="sm" variant="primary" busy={busy === "approve"} disabled={busy !== null} onClick={() => void decide(true)}>
          <Check size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Approve and write
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

/** The host's approval panel (desktop app only). Shows every change waiting on this computer, whichever chat it came from. */
export function ApprovalDock({ projectName }: { projectName: (id: string) => string }) {
  const pending = useHostApprovals();
  const [views, setViews] = useState<Record<string, View>>({});
  if (pending.length === 0) return null;
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
    </aside>
  );
}
