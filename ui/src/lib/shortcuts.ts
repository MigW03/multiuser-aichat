const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

/** Cmd+B on a Mac, Ctrl+B elsewhere: show or hide the left panel. */
export const PANEL_SHORTCUT = {
  label: isMac ? "⌘B" : "Ctrl+B",
  keys: isMac ? "Meta+B" : "Control+B",
  matches: (e: KeyboardEvent) => e.code === "KeyB" && !e.shiftKey && !e.altKey && (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey),
};

const mod = (e: KeyboardEvent) => (isMac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey);
const inDesktopApp = typeof globalThis !== "undefined" && !!(globalThis as { desktop?: unknown }).desktop;

/**
 * Cmd+Shift+O (Ctrl+Shift+O off a Mac): start a new chat. The desktop app also takes Cmd+N / Ctrl+N; a browser keeps
 * that key for its own new window, so a page never sees it.
 */
export const NEW_CHAT_SHORTCUT = {
  label: inDesktopApp ? (isMac ? "⌘N" : "Ctrl+N") : isMac ? "⌘⇧O" : "Ctrl+Shift+O",
  keys: inDesktopApp ? (isMac ? "Meta+N" : "Control+N") : isMac ? "Meta+Shift+O" : "Control+Shift+O",
  matches: (e: KeyboardEvent) =>
    !e.altKey &&
    mod(e) &&
    ((e.code === "KeyO" && !!e.shiftKey) || (inDesktopApp && e.code === "KeyN" && !e.shiftKey)),
};
