import { Markdown } from "@/components/markdown";

export type ChatCheckpoint = { id: string; covers_through_seq: number; summary: string; model: string | null };

/** Marks where the AI's memory switches from a summary to full messages. Older messages stay visible above it. */
export function SummaryDivider({ checkpoint }: { checkpoint: ChatCheckpoint }) {
  return (
    <details className="group my-2 text-xs text-neutral-500">
      <summary className="flex cursor-pointer list-none items-center gap-3 select-none">
        <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
        <span>Earlier messages summarized for the AI</span>
        <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
      </summary>
      <div className="mt-2 rounded-xl border border-neutral-200 px-4 py-2 text-sm text-neutral-700 dark:border-neutral-800 dark:text-neutral-300">
        <Markdown>{checkpoint.summary}</Markdown>
        {checkpoint.model && <p className="mt-2 text-xs text-neutral-500">Written by {checkpoint.model}</p>}
      </div>
    </details>
  );
}
