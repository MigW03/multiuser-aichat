const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

/** Cmd+B on a Mac, Ctrl+B elsewhere: show or hide the left panel. */
export const PANEL_SHORTCUT = {
  label: isMac ? "⌘B" : "Ctrl+B",
  keys: isMac ? "Meta+B" : "Control+B",
  matches: (e: KeyboardEvent) => e.code === "KeyB" && !e.shiftKey && !e.altKey && (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey),
};
