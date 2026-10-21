// Small per-device preferences. Storage can be blocked (private windows, strict settings), so every access is guarded.

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not remembered */
  }
}

export function clearPref(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to clear */
  }
}

/** Keys used by the app, in one place. */
export const PREF = {
  leftCollapsed: (userId: string) => `mc.leftCollapsed.${userId}`,
  leftWidth: (userId: string) => `mc.leftWidth.${userId}`,
  rightWidth: (userId: string) => `mc.rightWidth.${userId}`,
  /** How the right column's height is shared: the part the Files card takes (0 to 1), the rest is Notes. */
  filesShare: (userId: string) => `mc.filesShare.${userId}`,
  /** Which tab of the Files card is open: "files" or "scripts". */
  filesTab: (userId: string) => `mc.filesTab.${userId}`,
  /** Hide the privacy notice before inviting / joining ("Never show this again"). */
  hideInviteNotice: (userId: string) => `mc.hideInviteNotice.${userId}`,
  hideJoinNotice: (userId: string) => `mc.hideJoinNotice.${userId}`,
  /** An invite token the person was opening when they had to sign in or confirm their email first. */
  pendingJoin: "mc.pendingJoin",
  lastRoute: (userId: string) => `mc.lastRoute.${userId}`,
  /** The shared folder panel is open (on wide screens; a small screen opens it as a drawer each time). */
  folderOpen: (userId: string) => `mc.folderOpen.${userId}`,
  /** The preview's width beside the chat (px) and the last address opened in it, per project ("home" for chats outside projects). */
  previewWidth: (userId: string) => `mc.previewWidth.${userId}`,
  previewUrl: (userId: string, projectId: string | null) => `mc.previewUrl.${userId}.${projectId ?? "home"}`,
} as const;
