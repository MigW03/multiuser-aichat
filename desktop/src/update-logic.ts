// Pure rules for the desktop app's updates (no Electron here, so they can be tested).

export const RELEASES_URL = "https://github.com/MigW03/multiuser-aichat/releases";

/** What the page may know about updates. */
export type UpdateState = {
  /** "unavailable": a dev run or a platform the app cannot update (nothing is shown). */
  status: "unavailable" | "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  current: string;
  /** The newer version, once one is found. */
  version?: string;
  /** Download progress, 0-100. */
  percent?: number;
  /** When the last check finished, ms since 1970. */
  checkedAt?: number;
  /** The app installs it by itself: "auto". "manual": the person downloads the installer (a Mac build without a Developer ID cannot swap itself). */
  mode: "auto" | "manual" | "off";
  /** Download new versions without asking. */
  auto: boolean;
  /** Where the release notes are. */
  notesUrl?: string;
};

export type UpdateEvent =
  | { type: "checking" }
  | { type: "none"; at: number }
  | { type: "found"; version: string; at: number }
  | { type: "downloading"; percent: number }
  | { type: "ready"; version: string }
  | { type: "failed"; quiet: boolean }
  | { type: "auto"; on: boolean };

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,32})?$/;
export const isVersion = (v: unknown): v is string => typeof v === "string" && VERSION.test(v);

/** The release notes page for a version. Only a well-formed version makes an address, so nothing else can be opened through it. */
export const releaseUrl = (version: unknown): string | null => (isVersion(version) ? `${RELEASES_URL}/tag/v${version}` : null);

/**
 * Windows installs by itself. A Mac build only can once it is signed with an Apple Developer ID and notarized; until then the person
 * downloads the new version. Linux builds are not supported.
 */
export const installMode = (platform: string, macSigned: boolean): UpdateState["mode"] =>
  platform === "win32" ? "auto" : platform === "darwin" ? (macSigned ? "auto" : "manual") : "off";

export const initialState = (current: string, mode: UpdateState["mode"], auto: boolean, supported: boolean): UpdateState => ({
  status: supported && mode !== "off" ? "idle" : "unavailable",
  current,
  mode,
  auto,
});

/** A newer download that is on its way or done is never thrown away by a later check that finds the same thing. */
export function reduce(state: UpdateState, event: UpdateEvent): UpdateState {
  if (state.status === "unavailable") return state;
  switch (event.type) {
    case "auto":
      return { ...state, auto: event.on };
    case "checking":
      return state.status === "downloading" || state.status === "ready" ? state : { ...state, status: "checking" };
    case "none":
      return state.status === "downloading" || state.status === "ready"
        ? state
        : { current: state.current, mode: state.mode, auto: state.auto, status: "idle", checkedAt: event.at };
    case "found": {
      if (state.status === "downloading" || (state.status === "ready" && state.version === event.version)) return state;
      const notesUrl = releaseUrl(event.version);
      if (!notesUrl) return { ...state, status: "idle", checkedAt: event.at };
      return { current: state.current, mode: state.mode, auto: state.auto, status: "available", version: event.version, notesUrl, checkedAt: event.at };
    }
    case "downloading":
      return { ...state, status: "downloading", percent: Math.max(0, Math.min(100, Math.round(event.percent))) };
    case "ready":
      return { ...state, status: "ready", version: event.version, notesUrl: releaseUrl(event.version) ?? undefined, percent: undefined };
    case "failed":
      // A check in the background that fails stays quiet; the person sees an error only for a check they asked for.
      if (event.quiet) return state.status === "checking" ? { ...state, status: state.version ? "available" : "idle" } : state;
      return { ...state, status: "error" };
  }
}

/** Whether a background check should look now: not while a download runs or is waiting for a restart. */
export const shouldAutoCheck = (state: UpdateState): boolean =>
  state.status === "idle" || state.status === "error" || state.status === "available";

/** After a check finds a version: download without asking, or wait for the person. */
export const shouldAutoDownload = (state: UpdateState): boolean => state.mode === "auto" && state.auto;
