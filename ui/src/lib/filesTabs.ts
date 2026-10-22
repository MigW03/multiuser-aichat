// The tabs of the Files card: Files, Scripts, and one tab per linked service (Supabase, Vercel). The card is a narrow
// column, so when two service tabs show, only the open one keeps its name; the other is just its icon.

export type FilesTab = "files" | "scripts" | "supabase" | "vercel";
export const SERVICE_TABS = ["supabase", "vercel"] as const;

/** Whether a tab shows its name. Files and Scripts always do; a service tab does when it is open or the only service tab. */
export function tabShowsName(tab: FilesTab, active: FilesTab, shown: readonly FilesTab[]): boolean {
  if (tab === "files" || tab === "scripts") return true;
  if (tab === active) return true;
  return shown.filter((t) => (SERVICE_TABS as readonly string[]).includes(t)).length < 2;
}

/** The tab a saved choice opens: that tab when it is shown, Files otherwise. */
export function pickedTab(saved: unknown, shown: readonly FilesTab[]): FilesTab {
  return typeof saved === "string" && (shown as readonly string[]).includes(saved) ? (saved as FilesTab) : "files";
}
