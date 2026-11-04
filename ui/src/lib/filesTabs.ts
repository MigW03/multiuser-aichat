// The tabs of the Files card: Files, Scripts, and one tab per linked service (Supabase, Vercel). The card is a narrow
// column, so when two service tabs show, only the open one keeps its name; the other is just its icon.

export type FilesTab = "files" | "designs" | "scripts" | "supabase" | "vercel" | `panel:${string}`;
export const SERVICE_TABS = ["supabase", "vercel"] as const;

/** Whether a tab shows its name. Files, Designs and Scripts always do; a service tab does when it is open or the only service tab. */
export function tabShowsName(tab: FilesTab, active: FilesTab, shown: readonly FilesTab[]): boolean {
  if (tab === "files" || tab === "designs" || tab === "scripts") return true;
  if (tab === active) return true;
  // A custom panel shows its name only while it is open: the card is narrow.
  if (tab.startsWith("panel:")) return false;
  return shown.filter((t) => (SERVICE_TABS as readonly string[]).includes(t)).length < 2;
}

/** The tab a saved choice opens: that tab when it is shown, Files otherwise. */
export function pickedTab(saved: unknown, shown: readonly FilesTab[]): FilesTab {
  return typeof saved === "string" && (shown as readonly string[]).includes(saved) ? (saved as FilesTab) : "files";
}

// ---- the AI's custom panels (desktop app): one tab each, after the services

export const panelTab = (id: string): FilesTab => `panel:${id}`;
export const panelIdOf = (tab: FilesTab): string | null => (tab.startsWith("panel:") ? tab.slice("panel:".length) : null);
/** Panels with a tab of their own; the rest go behind "▾ n". */
export const PANEL_TABS_SHOWN = 3;

/** Which panels get a tab in the strip and which go behind the "▾ n" menu. The open panel always has its tab. */
export function splitPanelTabs(ids: readonly string[], active: string | null, max = PANEL_TABS_SHOWN): { shown: string[]; hidden: string[] } {
  const shown = ids.slice(0, max);
  if (active && ids.includes(active) && !shown.includes(active)) shown[shown.length - 1] = active;
  return { shown, hidden: ids.filter((id) => !shown.includes(id)) };
}
