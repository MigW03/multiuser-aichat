import { FOLDER_LIMITS as L, isDesignPath, type AiEditState, type ChangePreview, type FolderCaps, type FolderGlobResult, type FolderListResult, type FolderSearchResult } from "@mc/shared";
import { RelayError, type CallOptions, type Relay, type RelayRequest, type ShareItemOut } from "./folder-relay.ts";

// The hub sits between the project's members (and the AI answering them) and the owners' apps. A project's files are
// several items, each shared by one person from their own computer. Every path starts with the name of an item, so the
// hub reads that first segment, looks the item up in the database's list of APPROVED items, and sends the request to
// its owner's app. Nothing an app says about what it serves is believed: a path that does not start with an approved
// item's name (or points into an item of someone else) is refused here, and results coming back from an app are cut to
// the items it is allowed to serve.

export type Share = { id: string; owner_id: string; item_key: string; name: string; kind: "dir" | "file"; status: "pending" | "active" };

export type HubDeps = {
  /** Every item of the project, approved or not. */
  loadShares: (projectId: string) => Promise<Share[]>;
};

const SHARES_TTL_MS = 3_000;
const none: FolderCaps = { edit: false, git: false, exec: false };

const notFound = () => new RelayError("host", "That file or folder doesn't exist in the shared folder.", "not_found");
const several = () => new RelayError("host", "Several folders are shared, so this cannot tell which one you mean. Start the path with the folder's name.", "bad_request");
const nothing = () => new RelayError("host", "Nothing is shared in this project right now.", "not_found");
const spoofed = () => new RelayError("bad_answer", "The app sent an answer that could not be used.");

/** The first path segment, which names an item. "" for the top level. */
const firstSegment = (path: string | undefined) => (path ?? "").split("/").filter(Boolean)[0] ?? "";

export function createHub(relay: Relay, deps: HubDeps) {
  const cache = new Map<string, { at: number; shares: Promise<Share[]> }>();

  /** The project's approved items. Cached for a few seconds and dropped whenever something changes. */
  function active(projectId: string): Promise<Share[]> {
    const hit = cache.get(projectId);
    if (hit && Date.now() - hit.at < SHARES_TTL_MS) return hit.shares;
    const shares = deps.loadShares(projectId).then((all) => all.filter((s) => s.status === "active"));
    shares.catch(() => cache.delete(projectId));
    cache.set(projectId, { at: Date.now(), shares });
    return shares;
  }

  /** An answer may only talk about the item that was asked about: a path outside it is refused, not passed on. */
  const within = (item: Share, path: string) => firstSegment(path) === item.name;
  async function asked<T extends { path: string }>(item: Share, answer: Promise<T>): Promise<T> {
    const r = await answer;
    if (!within(item, r.path)) throw spoofed();
    return r;
  }

  const owners = (shares: Share[]) => [...new Set(shares.map((s) => s.owner_id))];

  /** The approved item a path points into. */
  function itemFor(shares: Share[], path: string | undefined): Share {
    const name = firstSegment(path);
    const item = name ? shares.find((s) => s.name === name) : undefined;
    if (!item) throw name ? notFound() : several();
    return item;
  }

  /** For requests with no path: the one folder the project shares, when there is exactly one. */
  function onlyFolder(shares: Share[]): Share {
    const dirs = shares.filter((s) => s.kind === "dir");
    if (shares.length === 0) throw nothing();
    if (dirs.length !== 1) throw several();
    return dirs[0]!;
  }

  /** A path-less request goes to the only folder, one with a path to the item it names. */
  const target = (shares: Share[], path: string | undefined) => (firstSegment(path) ? itemFor(shares, path) : onlyFolder(shares));

  /** Keeps only results that lie inside an item this owner is allowed to serve. */
  const inside = (shares: Share[], owner: string) => {
    const names = new Set(shares.filter((s) => s.owner_id === owner).map((s) => s.name));
    return (path: string) => names.has(firstSegment(path));
  };

  async function fanOut<T>(projectId: string, shares: Share[], make: (owner: string) => Promise<T>): Promise<{ owner: string; result: T }[]> {
    const online = new Set(relay.onlineOwners(projectId));
    const here = owners(shares).filter((o) => online.has(o));
    if (here.length === 0) throw new RelayError("offline", "The desktop apps of the people who share these files are offline.");
    const settled = await Promise.allSettled(here.map(async (owner) => ({ owner, result: await make(owner) })));
    const ok = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    if (ok.length === 0) throw (settled[0] as PromiseRejectedResult).reason;
    return ok;
  }

  async function call(projectId: string, req: RelayRequest, opts: CallOptions = {}): Promise<unknown> {
    const shares = await active(projectId);
    if (shares.length === 0) throw nothing();

    switch (req.op) {
      case "list": {
        if (!firstSegment(req.path)) {
          const entries = shares
            .map((s) => ({ name: s.name, type: s.kind }))
            .sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
          return { path: "", entries, truncated: false } satisfies FolderListResult;
        }
        const item = itemFor(shares, req.path);
        return asked(item, relay.callOwner(projectId, item.owner_id, req, opts));
      }
      case "read": {
        const item = itemFor(shares, req.path);
        return asked(item, relay.callOwner(projectId, item.owner_id, req, opts));
      }
      case "edit":
      case "write": {
        const item = itemFor(shares, req.path);
        // A preview of a change to a file in some other item is not shown: the diff on the answer is only trusted for the item asked about.
        const onPreview = opts.onPreview && ((change: ChangePreview) => (within(item, change.path) ? opts.onPreview!(change) : undefined));
        return asked(item, relay.callOwner(projectId, item.owner_id, req, { ...opts, onPreview }));
      }
      case "glob":
      case "grep": {
        if (firstSegment(req.path)) {
          const item = itemFor(shares, req.path);
          const result = await relay.callOwner(projectId, item.owner_id, req as never, opts);
          return req.op === "glob"
            ? ({ ...(result as FolderGlobResult), paths: (result as FolderGlobResult).paths.filter((p) => within(item, p)) } satisfies FolderGlobResult)
            : ({ ...(result as FolderSearchResult), matches: (result as FolderSearchResult).matches.filter((m) => within(item, m.path)) } satisfies FolderSearchResult);
        }
        const limit = Math.min(req.limit ?? L.searchLimit, L.searchLimit);
        const answers = await fanOut(projectId, shares, (owner) => relay.callOwner(projectId, owner, req as never, opts));
        if (req.op === "glob") {
          const merged = answers.flatMap(({ owner, result }) => (result as FolderGlobResult).paths.filter(inside(shares, owner)));
          return { paths: merged.slice(0, limit), truncated: merged.length > limit || answers.some(({ result }) => (result as FolderGlobResult).truncated) } satisfies FolderGlobResult;
        }
        const merged = answers.flatMap(({ owner, result }) => (result as FolderSearchResult).matches.filter((m) => inside(shares, owner)(m.path)));
        return { matches: merged.slice(0, limit), truncated: merged.length > limit || answers.some(({ result }) => (result as FolderSearchResult).truncated) } satisfies FolderSearchResult;
      }
      case "git": {
        const path = "path" in req ? req.path : undefined;
        return relay.callOwner(projectId, target(shares, path).owner_id, req, opts);
      }
      case "git_change": {
        const path = req.action === "add" || req.action === "restore" ? req.paths[0] : undefined;
        const item = target(shares, path);
        // Every path of one action must lie in the same item: one action, one repository, one owner.
        if ((req.action === "add" || req.action === "restore") && req.paths.some((p) => firstSegment(p) !== firstSegment(req.paths[0]))) throw several();
        return relay.callOwner(projectId, item.owner_id, req, opts);
      }
      case "exec":
        return relay.callOwner(projectId, target(shares, req.workdir).owner_id, req, opts);
      case "design_read":
      case "design_write":
      case "design_edit": {
        // Design files only: the owner's app checks again, and answers about the item asked about only.
        if (!isDesignPath(req.path)) throw new RelayError("host", "Only design files (ending in .design.html) can be opened or saved this way.", "bad_request");
        const item = itemFor(shares, req.path);
        return asked(item, relay.callOwner(projectId, item.owner_id, req as never, opts) as Promise<{ path: string }>);
      }
    }
  }

  return {
    call: call as <K extends RelayRequest["op"]>(projectId: string, req: Extract<RelayRequest, { op: K }>, opts?: CallOptions) => Promise<never>,

    /** What the AI may propose in this project: whatever any connected owner of an approved item allows. Each app still decides for itself. */
    async caps(projectId: string): Promise<FolderCaps> {
      const shares = await active(projectId).catch(() => [] as Share[]);
      const online = new Set(relay.onlineOwners(projectId));
      const mine = owners(shares).filter((o) => online.has(o)).map((o) => relay.capsOf(projectId, o));
      return mine.length ? { edit: mine.some((c) => c.edit), git: mine.some((c) => c.git), exec: mine.some((c) => c.exec) } : none;
    },

    /** Why the AI can or cannot propose edits: no owner's app is connected ("offline"), none that is connected allows it ("off"), or one does ("edit"). */
    async editState(projectId: string): Promise<AiEditState> {
      const c = await this.caps(projectId);
      if (c.edit) return "edit";
      const shares = await active(projectId).catch(() => [] as Share[]);
      const online = new Set(relay.onlineOwners(projectId));
      return owners(shares).some((o) => online.has(o)) ? "off" : "offline";
    },

    /** Forget what was cached about a project, after an item was approved, declined, removed or reported. */
    invalidate: (projectId: string) => void cache.delete(projectId),

    /** What the project calls every item of one owner, for their app. */
    async itemsOf(projectId: string, ownerId: string): Promise<ShareItemOut[]> {
      const all = await deps.loadShares(projectId);
      return all.filter((s) => s.owner_id === ownerId).map((s) => ({ key: s.item_key, name: s.name, status: s.status }));
    },
  };
}

export type Hub = ReturnType<typeof createHub>;
