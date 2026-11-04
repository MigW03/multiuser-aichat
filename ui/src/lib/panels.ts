import type { PanelFull, PanelListItem, PanelMeta } from "@mc/shared";
import { useEffect, useState } from "react";

// Custom panels, as the desktop app keeps them on this computer. The page can read and tidy them; making or changing one
// comes only from a draft the person approves. In a browser (or an older app) there is no bridge and no panels.

export type PanelResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type PanelsBridge = {
  list: (projectId: string) => Promise<PanelResult<PanelListItem[]>>;
  get: (projectId: string, panelId: string) => Promise<PanelResult<PanelFull>>;
  saveState: (projectId: string, panelId: string, state: Record<string, unknown>) => Promise<PanelResult<void>>;
  rename: (projectId: string, panelId: string, name: string) => Promise<PanelResult<PanelMeta>>;
  setIcon: (projectId: string, panelId: string, icon: string) => Promise<PanelResult<PanelMeta>>;
  move: (projectId: string, panelId: string, delta: -1 | 1) => Promise<PanelResult<void>>;
  undo: (projectId: string, panelId: string) => Promise<PanelResult<PanelMeta>>;
  /** Asks in a window of the app's own; the value is false when the person cancelled. */
  clearState: (projectId: string, panelId: string) => Promise<PanelResult<boolean>>;
  delete: (projectId: string, panelId: string) => Promise<PanelResult<boolean>>;
  onChange: (callback: (projectId: string) => void) => () => void;
};

export const panelsBridge = (): PanelsBridge | null => (globalThis as { desktop?: { panels?: PanelsBridge } }).desktop?.panels ?? null;

/** This project's panels in tab order, current as they change. null: not in the desktop app, or not loaded yet. */
export function usePanels(projectId: string | null): PanelListItem[] | null {
  const [list, setList] = useState<PanelListItem[] | null>(null);
  const bridge = panelsBridge();
  useEffect(() => {
    if (!bridge || !projectId) return setList(null);
    let live = true;
    const load = () =>
      void bridge.list(projectId).then(
        (r) => live && setList(r.ok ? r.value : []),
        () => undefined,
      );
    load();
    const off = bridge.onChange((id) => id === projectId && load());
    return () => {
      live = false;
      off();
    };
  }, [bridge, projectId]);
  return list;
}
