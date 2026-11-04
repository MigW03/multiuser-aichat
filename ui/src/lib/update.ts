import { useEffect, useState } from "react";

/** What the desktop app reports about updates of itself (see desktop/src/update-logic.ts). Absent in a browser: the website updates on reload. */
export type UpdateState = {
  status: "unavailable" | "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  current: string;
  version?: string;
  percent?: number;
  checkedAt?: number;
  mode: "auto" | "manual" | "off";
  auto: boolean;
  notesUrl?: string;
};

export type UpdateBridge = {
  get: () => Promise<UpdateState | null>;
  check: () => Promise<UpdateState | null>;
  download: () => Promise<UpdateState | null>;
  install: () => Promise<boolean>;
  setAuto: (on: boolean) => Promise<UpdateState | null>;
  onState: (callback: (state: UpdateState) => void) => () => void;
};

export const updateBridge = (): UpdateBridge | null => {
  const b = (globalThis as { desktop?: { update?: UpdateBridge } }).desktop?.update;
  return b && typeof b.get === "function" ? b : null;
};

/** The app's update state, or null in a browser, in a dev run, or where the app cannot update. */
export function useUpdate(): { state: UpdateState | null; bridge: UpdateBridge | null } {
  const bridge = updateBridge();
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.get().then((s) => live && setState(s), () => undefined);
    const off = bridge.onState((s) => live && setState(s));
    return () => {
      live = false;
      off();
    };
  }, [bridge]);
  return { state: state && state.status !== "unavailable" ? state : null, bridge };
}

/** An update is waiting on the person (found but not downloaded, or downloaded and waiting for a restart). */
export const updateWaiting = (s: UpdateState | null): boolean => !!s && (s.status === "ready" || (s.status === "available" && !s.auto) || (s.status === "available" && s.mode === "manual"));

/** The button for the next step, as text. */
export function updateAction(s: UpdateState): { label: string; run: "download" | "install" } | null {
  if (s.status === "ready") return { label: "Restart to update", run: "install" };
  if (s.status === "available") return { label: s.mode === "manual" ? "Download" : "Download and install", run: "download" };
  return null;
}

/** One line for the current state. */
export function updateLine(s: UpdateState, now = Date.now()): string {
  switch (s.status) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Nido ${s.version} is available.`;
    case "downloading":
      return `Downloading ${s.version ?? "the update"}… ${s.percent ?? 0}%`;
    case "ready":
      return `Nido ${s.version} is ready.`;
    case "error":
      return "Could not check for updates.";
    default: {
      if (!s.checkedAt) return `Nido ${s.current} is the version you have.`;
      const mins = Math.max(0, Math.round((now - s.checkedAt) / 60000));
      return `Nido ${s.current} is the latest. Checked ${mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : "a while ago"}.`;
    }
  }
}
