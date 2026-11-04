import { checkDraft, PanelError, type DraftView, type PanelDraft, type PanelMeta } from "@mc/shared";
import { randomUUID } from "node:crypto";
import type { PanelStore } from "./panels-store.ts";

// What the AI proposes, waiting for the person. The AI (through the chat server) can only ADD A DRAFT here; nothing is made,
// changed or deleted until the person clicks in the app's own page, and the click names only the draft's id: what gets saved is
// the draft kept here, checked when it arrived, never anything the page sends. Drafts live in memory only: they are gone when the
// app closes, a day-old proposal is not something to click on, and a new one for the same panel replaces the old one.

const MAX_PENDING = 5;
/** All proposals kept at once, whoever they are for: a flood of requests can't fill the app's memory. */
const MAX_ALL = 50;
const TTL_MS = 2 * 60 * 60_000;

type Pending = DraftView & { userId: string };

export type { DraftView };

export class PanelDrafts {
  private readonly pending: Pending[] = [];

  constructor(
    private readonly store: PanelStore,
    private readonly onChange: (userId: string, projectId: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  private sweep() {
    const cutoff = this.now() - TTL_MS;
    for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i]!.createdAt < cutoff) this.pending.splice(i, 1);
  }

  private put(p: Pending): DraftView {
    this.sweep();
    // one proposal per panel (or per new name): the newest wins
    const same = (q: Pending) => q.userId === p.userId && q.projectId === p.projectId && (p.panelId ? q.panelId === p.panelId : q.kind === "new" && q.name.toLowerCase() === p.name.toLowerCase());
    for (let i = this.pending.length - 1; i >= 0; i--) if (same(this.pending[i]!)) this.pending.splice(i, 1);
    this.pending.push(p);
    const mine = this.pending.filter((q) => q.userId === p.userId && q.projectId === p.projectId);
    while (mine.length > MAX_PENDING) this.pending.splice(this.pending.indexOf(mine.shift()!), 1);
    while (this.pending.length > MAX_ALL) this.pending.shift();
    this.onChange(p.userId, p.projectId);
    return this.view(p);
  }

  private view({ userId: _userId, ...v }: Pending): DraftView {
    return v;
  }

  /** A proposal for a new panel, or a new version of `panelId`. Checked here; the page never gets to change it. */
  async propose(userId: string, projectId: string, panelId: string | undefined, rawDraft: unknown): Promise<DraftView> {
    const draft: PanelDraft = checkDraft(rawDraft);
    if (panelId === undefined) {
      const all = await this.store.list(userId, projectId);
      if (all.some((p) => !("broken" in p) && p.name.toLowerCase() === draft.name.toLowerCase())) throw new PanelError("name_taken", `A panel called "${draft.name}" already exists. To change it, update it (panel_list, then panel_draft with its panel_id).`);
      return this.put({ id: randomUUID(), userId, projectId, kind: "new", createdAt: this.now(), ...draft });
    }
    const current = await this.store.get(userId, projectId, panelId);
    const { name, icon, sources, functions, replaces } = current.meta;
    return this.put({ id: randomUUID(), userId, projectId, kind: "update", panelId: current.meta.id, createdAt: this.now(), ...draft, before: { name, icon, view: current.view, sources, functions, rev: current.meta.rev, ...(replaces ? { replaces } : {}) } });
  }

  /** The AI asked to delete a panel: a card with a button the person presses. It deletes nothing. */
  async proposeDelete(userId: string, projectId: string, panelId: string): Promise<DraftView> {
    const current = await this.store.get(userId, projectId, panelId);
    const { name, icon, sources, functions } = current.meta;
    return this.put({ id: randomUUID(), userId, projectId, kind: "delete", panelId: current.meta.id, createdAt: this.now(), name, icon, view: "", sources, functions, before: { name, icon, view: current.view, sources, functions, rev: current.meta.rev } });
  }

  list(userId: string, projectId: string): DraftView[] {
    this.sweep();
    return this.pending.filter((p) => p.userId === userId && p.projectId === projectId).map((p) => this.view(p));
  }

  private find(userId: string, projectId: string, id: string): Pending {
    this.sweep();
    const p = this.pending.find((q) => q.id === id && q.userId === userId && q.projectId === projectId);
    if (!p) throw new PanelError("not_found", "That proposal is gone (the app was closed, or it was replaced). Ask the AI again.");
    return p;
  }

  /** The person's click on Add / Update. A delete is not committed here: the person's Delete button runs the app's own confirm. */
  async commit(userId: string, projectId: string, id: string): Promise<{ kind: "new" | "update"; meta: PanelMeta }> {
    const p = this.find(userId, projectId, id);
    if (p.kind === "delete") throw new PanelError("bad_request", "That one is a delete request: press Delete.");
    const draft: PanelDraft = { name: p.name, icon: p.icon, view: p.view, sources: p.sources, functions: p.functions, ...(p.replaces ? { replaces: p.replaces } : {}) };
    let meta: PanelMeta;
    if (p.kind === "new") meta = await this.store.create(userId, projectId, draft);
    else {
      // The panel must still be the version the proposal was made against.
      const current = await this.store.get(userId, projectId, p.panelId!);
      if (current.meta.rev !== p.before!.rev) throw new PanelError("bad_request", "That panel changed since the proposal. Ask the AI again.");
      meta = await this.store.update(userId, projectId, p.panelId!, draft);
    }
    this.drop(p);
    return { kind: p.kind, meta };
  }

  discard(userId: string, projectId: string, id: string): void {
    this.drop(this.find(userId, projectId, id));
  }

  /** A panel was deleted: proposals about it are moot. */
  forgetPanel(userId: string, projectId: string, panelId: string): void {
    let changed = false;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      if (p.userId === userId && p.projectId === projectId && p.panelId === panelId) {
        this.pending.splice(i, 1);
        changed = true;
      }
    }
    if (changed) this.onChange(userId, projectId);
  }

  /** Everything this person had waiting, when they sign out. */
  clearUser(userId: string): void {
    for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i]!.userId === userId) this.pending.splice(i, 1);
  }

  private drop(p: Pending) {
    const i = this.pending.indexOf(p);
    if (i >= 0) this.pending.splice(i, 1);
    this.onChange(p.userId, p.projectId);
  }
}
