// Every color, size and font the UI uses. Components only use the CSS variables this file defines
// (see styles.css); nothing else should contain a literal color or pixel value.

export const theme = {
  color: {
    background: "#16171b",
    surface: "#1e1f24",
    surfaceHover: "#2a2b31",
    border: "#2f3037",
    text: "#e8e8ec",
    textMuted: "#8b8d98",
    textOnAccent: "#ffffff",
    accent: "#5b6cff",
    accentHover: "#7180ff",
    danger: "#ff6b6b",
    success: "#4cc38a",
    ownBubble: "#3341a8",
    otherBubble: "#2a2b31",
    aiBubble: "#1f2a2a",
    inputBackground: "#111216",
    placeholder: "#e8e8ec55",
    focusRing: "#5b6cff88",
  },
  size: {
    sidebarWidth: "260px",
    authFormWidth: "340px",
    bubbleMaxWidth: "620px",
    radius: "6px",
    bubbleRadius: "10px",
    gapXs: "4px",
    gapSm: "8px",
    gapMd: "12px",
    gapLg: "20px",
    controlHeight: "36px",
    border: "1px",
  },
  font: {
    family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    sizeSm: "12px",
    sizeMd: "14px",
    sizeLg: "16px",
    sizeXl: "22px",
    lineHeight: "1.45",
  },
} as const;

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Writes the theme as CSS variables: --color-surface, --size-gap-md, --font-size-sm, ... */
export function applyTheme(root: HTMLElement = document.documentElement) {
  for (const [group, values] of Object.entries(theme)) {
    for (const [name, value] of Object.entries(values)) root.style.setProperty(`--${group}-${kebab(name)}`, value);
  }
}
