// Every colour the UI uses is built here and written to CSS variables on <html>; styles.css only reads them.
// Neutrals are fixed. Everything that carries the accent (buttons, links, AI tints, own bubbles) is derived from
// ONE accent colour at runtime, so a future accent picker only has to call applyTheme with another hex.

export const DEFAULT_ACCENT = "#3d63a0"; // Steel

export type ThemePref = "system" | "light" | "dark";
export type ThemeMode = "light" | "dark";

const THEME_KEY = "mc.theme";

type Rgb = [number, number, number];

function parse(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a 6-digit hex colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

/** `amount` of `top` laid over `base`. */
function mix(base: string, top: string, amount: number): string {
  const a = parse(base);
  const b = parse(top);
  return toHex([0, 1, 2].map((i) => a[i]! + (b[i]! - a[i]!) * amount) as Rgb);
}

// Tint strengths measured from the approved Steel boards: light tints are the accent over white, dark tints over the
// dark frame at 1.4x strength.
const TINT_STRENGTH = { t4: 0.052, t8: 0.09, t12: 0.128, t20: 0.22, t40: 0.42 } as const;
const DARK_TINT_BOOST = 1.4;

const NEUTRALS = {
  light: {
    bg: "#fafafa",
    card: "#ffffff",
    muted: "#f4f4f5",
    border: "#e6e6e9",
    fg: "#0f1115",
    mutedFg: "#6b6f76",
    danger: "#dc2626",
    bubbleOther: "#f4f4f5",
    hoverRow: "#f4f4f5",
    hoverBtn: "#e6e6e9",
    unreadPeopleBg: "#3f3f46",
    unreadPeopleFg: "#ffffff",
    avatars: [
      ["#27272a", "#ffffff"],
      ["#71717a", "#ffffff"],
      ["#d4d4d8", "#27272a"],
    ],
    online: "#2f9e5b",
    offline: "#c7c8cd",
    overlay: "rgba(15, 17, 21, 0.4)",
    shadowPanel: "0 1px 2px rgba(0, 0, 0, 0.05)",
    shadowMenu: "0 8px 24px rgba(0, 0, 0, 0.12)",
    placeholder: "#9a9ea6",
  },
  dark: {
    bg: "#2a2a2e",
    card: "#323236",
    muted: "#3a3a3f",
    border: "#434349",
    fg: "#ececee",
    mutedFg: "#a8a9af",
    danger: "#dc2626",
    bubbleOther: "#3d3d43",
    hoverRow: "#424248",
    hoverBtn: "#505057",
    unreadPeopleBg: "#ececee",
    unreadPeopleFg: "#2a2a2e",
    avatars: [
      ["#e4e4e7", "#27272a"],
      ["#71717a", "#ffffff"],
      ["#3f3f46", "#e4e4e7"],
    ],
    online: "#3cb371",
    offline: "#5b5b63",
    overlay: "rgba(0, 0, 0, 0.55)",
    shadowPanel: "none",
    shadowMenu: "0 8px 24px rgba(0, 0, 0, 0.35)",
    placeholder: "#7d7e85",
  },
} as const;

/** All colour tokens for a mode, as CSS custom property name -> value. */
export function buildTokens(accent: string, mode: ThemeMode): Record<string, string> {
  const n = NEUTRALS[mode];
  const dark = mode === "dark";
  const base = dark ? n.bg : "#ffffff";
  const tint = (key: keyof typeof TINT_STRENGTH) => mix(base, accent, TINT_STRENGTH[key] * (dark ? DARK_TINT_BOOST : 1));
  const t: Record<string, string> = {
    "--bg": n.bg,
    "--card": n.card,
    "--muted": n.muted,
    "--border": n.border,
    "--fg": n.fg,
    "--muted-fg": n.mutedFg,
    "--danger": n.danger,
    "--danger-tint": mix(n.card, n.danger, dark ? 0.22 : 0.08),
    "--p": accent,
    "--p-fg": "#ffffff",
    // Accent-coloured text: darker than the accent on light surfaces, lighter on dark ones.
    "--p-text": dark ? mix(accent, "#ffffff", 0.5) : mix(accent, "#000000", 0.25),
    "--t4": tint("t4"),
    "--t8": tint("t8"),
    "--t12": tint("t12"),
    "--t20": tint("t20"),
    "--t40": tint("t40"),
    "--bubble-other": n.bubbleOther,
    "--bubble-own": dark ? mix(n.bg, accent, 0.38) : tint("t12"),
    "--bubble-ai": dark ? tint("t12") : tint("t4"),
    "--bubble-ai-border": dark ? mix(n.bg, accent, 0.45) : tint("t20"),
    "--hover-row": n.hoverRow,
    "--hover-btn": n.hoverBtn,
    "--unread-people-bg": n.unreadPeopleBg,
    "--unread-people-fg": n.unreadPeopleFg,
    "--online": n.online,
    "--offline": n.offline,
    "--overlay": n.overlay,
    "--shadow-panel": n.shadowPanel,
    "--shadow-menu": n.shadowMenu,
    "--placeholder": n.placeholder,
  };
  n.avatars.forEach(([bg, fg], i) => {
    t[`--av${i + 1}-bg`] = bg;
    t[`--av${i + 1}-fg`] = fg;
  });
  return t;
}

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage can be blocked; fall back to the system setting */
  }
  return "system";
}

const systemDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
export const resolveMode = (pref: ThemePref): ThemeMode => (pref === "system" ? (systemDark() ? "dark" : "light") : pref);

let accentInUse = DEFAULT_ACCENT;
let prefInUse: ThemePref = "system";
let watching = false;

function paint(root: HTMLElement) {
  const mode = resolveMode(prefInUse);
  for (const [name, value] of Object.entries(buildTokens(accentInUse, mode))) root.style.setProperty(name, value);
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
}

/** Writes the colour tokens. Call once at start-up; call setThemePref when the person changes it in Settings. */
export function applyTheme(root: HTMLElement = document.documentElement, accent: string = DEFAULT_ACCENT) {
  accentInUse = accent;
  prefInUse = getThemePref();
  paint(root);
  if (!watching && typeof matchMedia === "function") {
    watching = true;
    // "System" follows the computer and switches by itself.
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => prefInUse === "system" && paint(root));
  }
}

export function setThemePref(pref: ThemePref, root: HTMLElement = document.documentElement) {
  prefInUse = pref;
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* not remembered, still applied */
  }
  paint(root);
}
