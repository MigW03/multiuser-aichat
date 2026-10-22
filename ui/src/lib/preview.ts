import { useEffect, useState } from "react";

// The preview of a web page from this computer (a project being developed on localhost), shown in the main panel. Only the
// desktop app can do it: it runs on the same computer as the page and draws it in a browser view of its own. In a browser
// `previewBridge()` is null and nothing about it shows.

export type PreviewState = {
  /** `run`: a shared HTML file served by the app with scripts but no network (Run page). Absent in older builds of the app. */
  mode?: "localhost" | "run";
  url: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  /** `refused`: nothing is listening at the address (the dev server is not running). */
  error: { kind: "refused" | "failed"; text: string } | null;
};

export type Rect = { x: number; y: number; width: number; height: number };

/** What the desktop app's preload script offers for the preview. The previewed page itself never gets any of it. */
export type PreviewBridge = {
  open: (url: string, bounds: Rect) => Promise<{ ok: boolean; url?: string }>;
  setBounds: (bounds: Rect) => void;
  setVisible: (visible: boolean) => Promise<string | null>;
  reload: (quiet?: boolean) => void;
  back: () => void;
  forward: () => void;
  close: () => void;
  openExternal: () => void;
  get: () => Promise<PreviewState | null>;
  scan: () => Promise<number[]>;
  clearData: () => Promise<boolean>;
  onState: (callback: (state: PreviewState | null) => void) => () => void;
};

export const previewBridge = (): PreviewBridge | null => {
  const b = (globalThis as { desktop?: { preview?: PreviewBridge } }).desktop?.preview;
  return b && typeof b.open === "function" ? b : null;
};

/** What the preview shows now, as the app reports it. */
export function usePreviewState(bridge: PreviewBridge): PreviewState | null {
  const [state, setState] = useState<PreviewState | null>(null);
  useEffect(() => {
    let live = true;
    void bridge.get().then((s) => live && setState(s), () => undefined);
    const off = bridge.onState((s) => live && setState(s));
    return () => {
      live = false;
      off();
    };
  }, [bridge]);
  return state;
}

/** Elements that float above the page (dialogs, menus, hints, notices). The preview sits above everything else, so it steps aside when one reaches it. */
export const FLOATING = ".overlay, .menu, .info-tip, .toasts .toast, .approval-dock, .drawer, .drawer-backdrop";

export const intersects = (a: Rect, b: DOMRect) => a.x < b.right && a.x + a.width > b.left && a.y < b.bottom && a.y + a.height > b.top;
