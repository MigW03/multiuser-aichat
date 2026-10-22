import type { ScriptsInfo } from "@mc/shared";

/**
 * Whether the Files card shows its Scripts tab: only when a shared folder has scripts to run. A script that still has a
 * run to show (running, waiting for approval, or a crash not looked at) keeps the tab until it is gone, even if
 * package.json lost the script meanwhile.
 */
export function showScriptsTab(info: ScriptsInfo | null): boolean {
  if (!info) return false;
  return info.scripts.length > 0 || info.runs.length > 0;
}
