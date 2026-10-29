import { FOLDER_LIMITS as L, type ChangePreview, type FolderResponse } from "@mc/shared";
import type { AutoDecision } from "./folder-auto.ts";
import { commitStaged, type Staged } from "./folder-changes.ts";
import type { ExecStaged } from "./folder-exec.ts";
import type { GitStaged } from "./folder-git.ts";
import { FolderError } from "./folder-fs.ts";

// Proposals waiting for the host. A proposal lives only in this app's memory: the chat server can ask for one and can
// cancel it, but only the host's click in this app (decide) ever writes anything. Two things are approved in advance: a
// command the host ticked "always allow" for in the confirmation window (folder-allow.ts: an exact match runs at once), and,
// when the host chose it for the project in a window this app shows, what folder-auto.ts lets through (edits that cannot
// run code, a short list of read-only and project-check commands). Everything else waits here for the click.

export type PendingView = {
  projectId: string;
  id: string;
  change: ChangePreview;
  askedBy: string;
  readFiles: number;
  expiresAt: number;
  /** The confirmation window will offer "always allow" for it. */
  canAlwaysAllow?: boolean;
  /** Why it asks although the host let safe things through, in one plain sentence. Only a hint. */
  reason?: string;
  /** Files the AI saved without asking that nobody reviewed: shown with a command that was held back for them. */
  unreviewed?: string[];
};

export type Kind = "files" | "git" | "exec";
export type AnyStaged = Staged | GitStaged | ExecStaged;
const kindOf = (s: AnyStaged): Kind => ("exec" in s ? "exec" : "git" in s ? "git" : "files");

type Entry = {
  view: PendingView;
  staged: AnyStaged;
  /** A native confirmation window is open for it. */
  deciding?: boolean;
  timer: ReturnType<typeof setTimeout>;
  settle: (res: FolderResponse) => void;
};

/** "auto": a rule the host made matches exactly, so it runs without asking. "offer": it asks, with the always-allow box. "no": it asks, with no box. */
export type AllowVerdict = "auto" | "offer" | "no";

export type AllowHooks = {
  check: (projectId: string, staged: ExecStaged) => Promise<AllowVerdict>;
  /** The host ticked the box: make the rule. */
  remember: (view: PendingView, staged: ExecStaged) => Promise<void>;
  /** A command ran (or failed to) because a rule matched. */
  ran: (view: PendingView, res: FolderResponse) => void;
};

export type AutoHooks = {
  /** Whether this may happen without asking. Called only when no always-allow rule matched. */
  check: (projectId: string, staged: AnyStaged) => Promise<AutoDecision>;
  /** It was saved or run without asking. */
  ran: (view: PendingView, res: FolderResponse, kind: "edit" | "read" | "check") => void;
  /** The files the AI saved without asking that nobody reviewed since. A command that runs project code asks while there are any, even one always allowed. */
  held: (projectId: string) => string[];
  /** The host approved a command (and was shown the unreviewed files with it). */
  reviewed: (projectId: string) => void;
};

export type ApprovalHooks = {
  /** A proposal is waiting for the host. */
  onAdd: (view: PendingView) => void;
  /** It was settled (approved, denied, expired, cancelled, or the connection ended). */
  onGone: (projectId: string, id: string) => void;
  /** Allowed to be called once more: false when the host switched what this kind of change needs off meanwhile. */
  stillAllowed: (projectId: string, kind: Kind) => boolean;
  /**
   * A window the page cannot click, shown by the app itself, that asks once more before a command runs. Resolves true
   * only when the person confirmed ("always": and ticked the always-allow box, which is offered only when the view says
   * `canAlwaysAllow`). Required: a command never runs on the page's click alone.
   */
  confirm: (view: PendingView) => Promise<boolean | "always">;
  allow?: AllowHooks;
  auto?: AutoHooks;
};

const key = (projectId: string, id: string) => `${projectId}\n${id}`;

export class Approvals {
  private readonly pending = new Map<string, Entry>();
  /** Commands that are running now, so they can be stopped. */
  private readonly running = new Map<string, { projectId: string; id: string; kill: () => void }>();
  /** Commands a rule let through that have not started yet. */
  private readonly starting = new Map<string, string>();

  constructor(
    private readonly hooks: ApprovalHooks,
    private readonly ms: number = L.approvalMs,
  ) {}

  count(projectId: string): number {
    return [...this.pending.values()].filter((e) => e.view.projectId === projectId).length;
  }

  /** Commands waiting or running in a project (one at a time). */
  execBusy(projectId: string): boolean {
    return [...this.pending.values()].some((e) => e.view.projectId === projectId && "exec" in e.staged) || [...this.running.values()].some((r) => r.projectId === projectId) || [...this.starting.values()].includes(projectId);
  }

  list(): PendingView[] {
    return [...this.pending.values()].map((e) => e.view);
  }

  /**
   * Waits for the host's decision. Resolves with the answer to send back to the server. `preview` shows everybody in the chat
   * what is proposed, once it is known whether it will wait (it carries `auto` when it will not).
   */
  async propose(projectId: string, staged: AnyStaged, ctx: { askedBy: string; readFiles: number; preview?: (change: ChangePreview) => void }): Promise<FolderResponse> {
    const k = key(projectId, staged.id);
    const open = () => this.pending.has(k) || this.starting.has(k);
    if (open()) return { id: staged.id, ok: false, code: "bad_request", message: "That request is already open." };
    const isExec = "exec" in staged;
    let verdict: AllowVerdict = isExec && this.hooks.allow ? await this.hooks.allow.check(projectId, staged).catch((): AllowVerdict => "no") : "no";
    // A rule the host made runs project code too: while the AI has saved files nobody reviewed, it asks like anything else.
    const held = verdict === "auto" && !staged.change.script ? (this.hooks.auto?.held(projectId) ?? []) : [];
    if (held.length > 0) verdict = "offer";
    const decision: AutoDecision = verdict !== "auto" && this.hooks.auto && kindOf(staged) !== "git" ? await this.hooks.auto.check(projectId, staged).catch((): AutoDecision => ({ auto: false })) : { auto: false };
    if (open()) return { id: staged.id, ok: false, code: "bad_request", message: "That request is already open." };
    const view: PendingView = {
      projectId,
      id: staged.id,
      change: staged.change,
      askedBy: ctx.askedBy,
      readFiles: ctx.readFiles,
      expiresAt: Date.now() + this.ms,
      ...(verdict === "offer" ? { canAlwaysAllow: true } : {}),
      ...(held.length > 0
        ? { reason: `Asking because the AI saved files without your review: ${held.slice(0, 3).join(", ")}${held.length > 3 ? ` and ${held.length - 3} more` : ""}. Commands run code in your project.`, unreviewed: held.slice(-20) }
        : {
            ...(!decision.auto && decision.reason ? { reason: decision.reason } : {}),
            ...(!decision.auto && decision.unreviewed?.length ? { unreviewed: decision.unreviewed } : {}),
          }),
    };
    if (verdict === "auto" || decision.auto) {
      // A rule the host made matches this exact command, or the host let this kind of thing through: it happens without asking. Nothing waits in the dock.
      if (isExec && this.execBusy(projectId)) return { id: staged.id, ok: false, code: "busy", message: "A command is already waiting for its owner or running. Wait for it to finish." };
      staged.change.auto = true;
      ctx.preview?.(staged.change);
      this.starting.set(k, projectId);
      let res: FolderResponse;
      try {
        res = await this.finish(k, projectId, staged.id, staged, true, true);
      } finally {
        this.starting.delete(k);
      }
      if (verdict === "auto") this.hooks.allow?.ran(view, res);
      else if (decision.auto) this.hooks.auto?.ran(view, res, decision.kind);
      return res;
    }
    ctx.preview?.(staged.change);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.end(k, { id: staged.id, ok: false, code: "expired", message: "Nobody approved this change in time, so it was dropped." }), this.ms);
      this.pending.set(k, { view, staged, timer, settle: resolve });
      this.hooks.onAdd(view);
    });
  }

  private end(k: string, res: FolderResponse) {
    const e = this.pending.get(k);
    if (!e) return;
    this.pending.delete(k);
    clearTimeout(e.timer);
    e.settle(res);
    this.hooks.onGone(e.view.projectId, e.view.id);
  }

  /** The host's decision. Approving runs it now (if it is still what the host looked at); a command asks once more in a native window first. */
  async decide(projectId: string, id: string, approve: boolean): Promise<boolean> {
    const k = key(projectId, id);
    const e = this.pending.get(k);
    if (!e) return false;
    if (approve && "exec" in e.staged) {
      // The page's click is not enough for a command: the app asks in its own window. Cancelling there leaves the card as it was.
      if (e.deciding) return true;
      e.deciding = true;
      const confirmed = await this.hooks.confirm(e.view).catch(() => false);
      if (confirmed === "always" && this.pending.get(k) === e && e.view.canAlwaysAllow) await this.hooks.allow?.remember(e.view, e.staged as ExecStaged).catch(() => undefined);
      e.deciding = false;
      if (this.pending.get(k) !== e) return false; // it ended while the window was open (expired, cancelled, switched off)
      if (!confirmed) return true;
      // The host saw the command (and the files the AI saved unreviewed, if it was held for them) and said yes.
      if (!e.view.change.script) this.hooks.auto?.reviewed(projectId);
    }
    // Taken out first, so a double click cannot run it twice.
    this.pending.delete(k);
    clearTimeout(e.timer);
    const res = await this.finish(k, projectId, id, e.staged, approve);
    e.settle(res);
    this.hooks.onGone(projectId, id);
    return true;
  }

  /** Declines, or runs, what the host (or a rule) decided on. The entry is already out of `pending`. */
  private async finish(k: string, projectId: string, id: string, staged: AnyStaged, approve: boolean, auto = false): Promise<FolderResponse> {
    const kind = kindOf(staged);
    let res: FolderResponse;
    if (!approve) {
      res = { id, ok: false, code: "denied", message: kind === "exec" ? "The host declined to run this command. It was not run." : "The host declined this change." };
    } else if (!this.hooks.stillAllowed(projectId, kind)) {
      res = { id, ok: false, code: "disabled", message: "The host turned off AI changes before this was approved." };
    } else {
      try {
        if ("exec" in staged) {
          const run = staged.run.bind(staged);
          try {
            const ran = await run((kill) => this.running.set(k, { projectId, id, kill }));
            res = { id, ok: true, result: auto ? { ...ran, auto: true } : ran };
          } finally {
            this.running.delete(k);
          }
        } else if ("git" in staged) {
          res = { id, ok: true, result: await staged.apply() };
        } else {
          await commitStaged(staged);
          const { path, created, added, removed } = staged.change;
          res = { id, ok: true, result: { path, created, added, removed, ...(auto ? { auto: true } : {}) } };
        }
      } catch (err) {
        if (err instanceof FolderError) res = { id, ok: false, code: err.code, message: err.message };
        else {
          console.error("[folder] approved action failed:", err instanceof Error ? err.message : err);
          res = { id, ok: false, code: "failed", message: "It couldn't be done." };
        }
      }
    }
    return res;
  }

  /** The server withdrew it (the chat's Stop button) or the connection ended. */
  cancel(projectId: string, id: string) {
    this.end(key(projectId, id), { id, ok: false, code: "expired", message: "The request was cancelled." });
    this.running.get(key(projectId, id))?.kill(); // a command already running is stopped
  }

  closeProject(projectId: string, message = "The host's app disconnected.", only?: Kind) {
    for (const [k, e] of this.pending) {
      if (e.view.projectId !== projectId) continue;
      if (only && kindOf(e.staged) !== only) continue;
      this.end(k, { id: e.view.id, ok: false, code: "expired", message });
    }
    if (!only || only === "exec") for (const r of this.running.values()) if (r.projectId === projectId) r.kill();
  }

  closeAll() {
    for (const r of this.running.values()) r.kill();
    for (const k of [...this.pending.keys()]) {
      const e = this.pending.get(k)!;
      this.end(k, { id: e.view.id, ok: false, code: "expired", message: "The host's app closed." });
    }
  }
}
