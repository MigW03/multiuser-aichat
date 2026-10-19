import { FOLDER_LIMITS as L, type ChangePreview, type FolderResponse } from "@mc/shared";
import { commitStaged, type Staged } from "./folder-changes.ts";
import type { GitStaged } from "./folder-git.ts";
import { FolderError } from "./folder-fs.ts";

// Proposals waiting for the host. A proposal lives only in this app's memory: the chat server can ask for one and can
// cancel it, but only the host's click in this app (decide) ever writes anything. Nothing is remembered between runs
// and nothing is approved in advance.

export type PendingView = { projectId: string; id: string; change: ChangePreview; askedBy: string; readFiles: number; expiresAt: number };

type Entry = {
  view: PendingView;
  staged: Staged | GitStaged;
  timer: ReturnType<typeof setTimeout>;
  settle: (res: FolderResponse) => void;
};

export type ApprovalHooks = {
  /** A proposal is waiting for the host. */
  onAdd: (view: PendingView) => void;
  /** It was settled (approved, denied, expired, cancelled, or the connection ended). */
  onGone: (projectId: string, id: string) => void;
  /** Allowed to be called once more: false when the host switched what this kind of change needs off meanwhile. */
  stillAllowed: (projectId: string, kind: "files" | "git") => boolean;
};

const key = (projectId: string, id: string) => `${projectId}\n${id}`;

export class Approvals {
  private readonly pending = new Map<string, Entry>();

  constructor(
    private readonly hooks: ApprovalHooks,
    private readonly ms: number = L.approvalMs,
  ) {}

  count(projectId: string): number {
    return [...this.pending.values()].filter((e) => e.view.projectId === projectId).length;
  }

  list(): PendingView[] {
    return [...this.pending.values()].map((e) => e.view);
  }

  /** Waits for the host's decision. Resolves with the answer to send back to the server. */
  propose(projectId: string, staged: Staged | GitStaged, ctx: { askedBy: string; readFiles: number }): Promise<FolderResponse> {
    const k = key(projectId, staged.id);
    if (this.pending.has(k)) return Promise.resolve({ id: staged.id, ok: false, code: "bad_request", message: "That request is already open." });
    return new Promise((resolve) => {
      const view: PendingView = { projectId, id: staged.id, change: staged.change, askedBy: ctx.askedBy, readFiles: ctx.readFiles, expiresAt: Date.now() + this.ms };
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

  /** The host's decision. Approving writes the file now (if it is still what the diff showed). */
  async decide(projectId: string, id: string, approve: boolean): Promise<boolean> {
    const k = key(projectId, id);
    const e = this.pending.get(k);
    if (!e) return false;
    // Taken out first, so a double click cannot write twice.
    this.pending.delete(k);
    clearTimeout(e.timer);
    let res: FolderResponse;
    if (!approve) {
      res = { id, ok: false, code: "denied", message: "The host declined this change." };
    } else if (!this.hooks.stillAllowed(projectId, "git" in e.staged ? "git" : "files")) {
      res = { id, ok: false, code: "disabled", message: "The host turned off AI changes before this was approved." };
    } else {
      try {
        if ("git" in e.staged) {
          res = { id, ok: true, result: await e.staged.apply() };
        } else {
          await commitStaged(e.staged);
          const { path, created, added, removed } = e.staged.change;
          res = { id, ok: true, result: { path, created, added, removed } };
        }
      } catch (err) {
        if (err instanceof FolderError) res = { id, ok: false, code: err.code, message: err.message };
        else {
          console.error("[folder] write failed:", err instanceof Error ? err.message : err);
          res = { id, ok: false, code: "failed", message: "The file couldn't be written." };
        }
      }
    }
    e.settle(res);
    this.hooks.onGone(projectId, id);
    return true;
  }

  /** The server withdrew it (the chat's Stop button) or the connection ended. */
  cancel(projectId: string, id: string) {
    this.end(key(projectId, id), { id, ok: false, code: "expired", message: "The request was cancelled." });
  }

  closeProject(projectId: string, message = "The host's app disconnected.", only?: "files" | "git") {
    for (const [k, e] of this.pending) {
      if (e.view.projectId !== projectId) continue;
      if (only && ("git" in e.staged ? "git" : "files") !== only) continue;
      this.end(k, { id: e.view.id, ok: false, code: "expired", message });
    }
  }

  closeAll() {
    for (const k of [...this.pending.keys()]) {
      const e = this.pending.get(k)!;
      this.end(k, { id: e.view.id, ok: false, code: "expired", message: "The host's app closed." });
    }
  }
}
