import type { ProjectSummary } from "@mc/shared";

/** How many projects the switcher lists before the person types. */
export const RECENT_LIMIT = 6;
/** How many project ids are remembered as recently opened. */
const REMEMBER = 12;

/** Put `id` first in the remembered list, without repeats, capped. Anything that is not a list of strings is dropped. */
export function pushRecent(stored: unknown, id: string): string[] {
  const old = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === "string") : [];
  return [id, ...old.filter((x) => x !== id)].slice(0, REMEMBER);
}

/**
 * The rows the switcher shows. With no search: the projects opened most recently first (the current one on top),
 * then the rest in list order, cut to RECENT_LIMIT. With a search: every project whose name matches, same order.
 */
export function switcherRows(projects: ProjectSummary[], recent: unknown, currentId: string | null, query: string): ProjectSummary[] {
  const rank = new Map<string, number>();
  (Array.isArray(recent) ? recent : []).forEach((id, i) => typeof id === "string" && !rank.has(id) && rank.set(id, i));
  const rankOf = (p: ProjectSummary) => (p.id === currentId ? -1 : (rank.get(p.id) ?? Number.MAX_SAFE_INTEGER));
  const q = query.trim().toLowerCase();
  const sorted = projects
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => rankOf(a.p) - rankOf(b.p) || a.i - b.i)
    .map(({ p }) => p);
  return q ? sorted : sorted.slice(0, RECENT_LIMIT);
}

/** Move a highlighted row by `delta`, wrapping at both ends. -1 means nothing is highlighted yet. */
export function stepIndex(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}
