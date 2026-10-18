import { FOLDER_LIMITS as L, type FolderGlobResult, type FolderSearchResult } from "@mc/shared";
import { Worker } from "node:worker_threads";
import { FolderError, type Target } from "./folder-fs.ts";
import type { Search } from "./folder-items.ts";

/**
 * Runs glob and grep in a worker thread and stops it past the time limit. Both take patterns written by the AI, and a
 * regular expression (or a glob compiled to one) can run for ever on some input.
 */
export function workerSearch(workerFile: string | URL): Search {
  const run = <T>(op: "glob" | "grep", targets: Target[], pattern: unknown, opts: Record<string, unknown>) =>
    new Promise<T>((resolve, reject) => {
      const worker = new Worker(workerFile, { workerData: { op, targets, pattern, opts }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new FolderError("timeout", "The search took too long. Narrow it with a path or an include pattern, or set literal to search for plain text."));
      }, L.searchMs + 3000);
      worker.once("message", (m: { ok: true; result: T } | { ok: false; code: FolderError["code"]; message: string }) => {
        clearTimeout(timer);
        void worker.terminate();
        if (m.ok) resolve(m.result);
        else reject(new FolderError(m.code, m.message));
      });
      worker.once("error", () => {
        clearTimeout(timer);
        reject(new FolderError("failed", "The search failed."));
      });
    });
  return {
    glob: (targets, pattern, opts) => run<FolderGlobResult>("glob", targets, pattern, opts),
    grep: (targets, pattern, opts) => run<FolderSearchResult>("grep", targets, pattern, opts),
  };
}
