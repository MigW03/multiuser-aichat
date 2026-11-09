import type { MessageMeta } from "@mc/shared";

export type ToolChip = {
  key: string;
  kind: "read" | "edit" | "failed" | "mcp";
  label: string;
  /** read, edit: the file path, so the chip can open it. */
  path?: string;
  /** The full text for the tooltip. */
  title: string;
};

/** Shown before "+N more". */
export const TOOL_CHIPS_SHOWN = 4;

const name = (path: string) => path.split("/").at(-1) || path;

/** What the AI did while writing an answer, from the answer's meta: files edited, files read, connected tools used. A file both read and edited shows once, as edited. */
export function toolChips(meta: Pick<MessageMeta, "files" | "edits" | "mcp">): ToolChip[] {
  const chips: ToolChip[] = [];
  const edited = new Set<string>();
  for (const e of meta.edits ?? []) {
    if (edited.has(e.p)) continue;
    edited.add(e.p);
    chips.push(e.ok ? { key: `e:${e.p}`, kind: "edit", label: `Edited ${name(e.p)}`, path: e.p, title: `Edited ${e.p}` } : { key: `e:${e.p}`, kind: "failed", label: `Not applied: ${name(e.p)}`, path: e.p, title: `Change to ${e.p} was not applied` });
  }
  for (const p of new Set(meta.files ?? [])) {
    if (!edited.has(p)) chips.push({ key: `r:${p}`, kind: "read", label: `Read ${name(p)}`, path: p, title: `Read ${p}` });
  }
  for (const t of new Set(meta.mcp ?? [])) chips.push({ key: `m:${t}`, kind: "mcp", label: t, title: `Used ${t}` });
  return chips;
}

/** Basenames the chips already show, so the file buttons under the answer do not repeat them. */
export function chipFileNames(chips: ToolChip[]): Set<string> {
  return new Set(chips.flatMap((c) => (c.path ? [name(c.path)] : [])));
}
