import { FOLDER_LIMITS as L, type ChangePreview, type FolderResponse } from "@mc/shared";
import { commitStaged, type Staged } from "./folder-changes.ts";
import type { ExecStaged } from "./folder-exec.ts";
import type { GitStaged } from "./folder-git.ts";
import { FolderError } from "./folder-fs.ts";

// Proposals waiting for the host. A proposal lives only in this app's memory: the chat server can ask for one and can
// cancel it, but only the host's click in this app (decide) ever writes anything. The one thing approved in advance is a
// command the host ticked "always allow" for in the confirmation window (folder-allow.ts): an exact match runs at once.

export type PendingView = { projectId: string; id: string; change: ChangePreview; askedBy: string; readFiles: number; expiresAt: number; /** The confirmation window will offer "always allow" for it. */ canAlwaysAllow?: boolean };

export type Kind = "files" | "git" | "exec";
type AnyStaged = Staged | GitStaged | ExecStaged;
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

  /** Waits for the host's decision. Resolves with the answer to send back to the server. */
  async propose(projectId: string, staged: AnyStaged, ctx: { askedBy: string; readFiles: number }): Promise<FolderResponse> {
    const k = key(projectId, staged.id);
    if (this.pending.has(k) || this.starting.has(k)) return { id: staged.id, ok: false, code: "bad_request", message: "That request is already open." };
    const verdict = "exec" in staged && this.hooks.allow ? await this.hooks.allow.check(projectId, staged).catch((): AllowVerdict => "no") : "no";
    if (this.pending.has(k) || this.starting.has(k)) return { id: staged.id, ok: false, code: "bad_request", message: "That request is already open." };
    const view: PendingView = { projectId, id: staged.id, change: staged.change, askedBy: ctx.askedBy, readFiles: ctx.readFiles, expiresAt: Date.now() + this.ms, ...(verdict === "offer" ? { canAlwaysAllow: true } : {}) };
    if (verdict === "auto") {
      // A rule the host made matches this exact command: it runs without asking. Nothing waits in the dock.
      if (this.execBusy(projectId)) return { id: staged.id, ok: false, code: "busy", message: "A command is already waiting for its owner or running. Wait for it to finish." };
      this.starting.set(k, projectId);
      let res: FolderResponse;
      try {
        res = await this.finish(k, projectId, staged.id, staged, true);
      } finally {
        this.starting.delete(k);
      }
      this.hooks.allow?.ran(view, res);
      return res;
    }
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
  private async finish(k: string, projectId: string, id: string, staged: AnyStaged, approve: boolean): Promise<FolderResponse> {
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
            res = { id, ok: true, result: await run((kill) => this.running.set(k, { projectId, id, kill })) };
          } finally {
            this.running.delete(k);
          }
        } else if ("git" in staged) {
          res = { id, ok: true, result: await staged.apply() };
        } else {
          await commitStaged(staged);
          const { path, created, added, removed } = staged.change;
          res = { id, ok: true, result: { path, created, added, removed } };
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
