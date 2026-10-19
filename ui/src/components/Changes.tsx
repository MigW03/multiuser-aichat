import type { ChangePreview } from "@mc/shared";
import { Check, FilePen, FilePlus, Hourglass, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { folderBridge, useHostApprovals, type PendingChange } from "../lib/folder.ts";
import { Button, ICON_SM, STROKE } from "./kit.tsx";
import type { Proposal } from "./useChatRoom.ts";

// AI changes to the shared files. Everybody in the chat sees what the AI proposes (a diff). Only the host decides, and
// only in the desktop app on the computer that holds the files: the dock below is the one place with buttons, and it
// is fed by the app itself, not by the chat server, so a message in the chat can't make a change look different.

/** A unified diff, one line per row, added and removed lines tinted. Text only: nothing in a diff is rendered as markup. */
export function DiffView({ diff, cut }: { diff: string; cut?: boolean }) {
  return (
    <pre className="diff" tabIndex={0}>
      {diff.split("\n").map((line, i) => (
        <span key={i} className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : ""}>
          {line || " "}
          {"\n"}
        </span>
      ))}
      {cut && <span className="hunk">The diff is cut here; the full change is applied if approved.{"\n"}</span>}
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

function PendingCard({ item, projectName }: { item: PendingChange; projectName: string }) {
  const bridge = folderBridge();
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

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
  return (
    <section className="dock-card" aria-label={`Change to ${c.path}`}>
      <header>
        <ShieldCheck size={ICON_SM} strokeWidth={STROKE} aria-hidden />
        <span className="grow">
          <b>{item.askedBy}</b>'s AI wants to {c.created ? "create" : "change"} <b>{c.path}</b> in {projectName}
        </span>
        <Stats change={c} />
      </header>
      {RISKY.test(c.path) && (
        <p className="small risky" role="note">
          This file can run code when the project is built, installed or pushed. Read the whole diff before approving.
        </p>
      )}
      <DiffView diff={c.diff} cut={c.cut} />
      <p className="small muted">
        It read {item.readFiles} {item.readFiles === 1 ? "file" : "files"} before proposing this. Check that the change is what was asked for. Nothing is written until you approve. Time left: {minutesLeft(item.expiresAt, now)}.
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
}

/** The host's approval panel (desktop app only). Shows every change waiting on this computer, whichever chat it came from. */
export function ApprovalDock({ projectName }: { projectName: (id: string) => string }) {
  const pending = useHostApprovals();
  if (pending.length === 0) return null;
  return (
    <aside className="approval-dock" role="region" aria-label="AI changes waiting for you" aria-live="polite">
      {pending.map((item) => (
        <PendingCard key={`${item.projectId}:${item.id}`} item={item} projectName={projectName(item.projectId)} />
      ))}
    </aside>
  );
}
