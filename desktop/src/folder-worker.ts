import { parentPort, workerData } from "node:worker_threads";
import { FolderError, globFiles, grepFiles, type Target } from "./folder-fs.ts";

// Runs one glob or grep off the main thread, so the app can stop a pattern that would never finish.
const { op, targets, pattern, opts } = workerData as { op: "glob" | "grep"; targets: Target[]; pattern: unknown; opts: Record<string, unknown> };
(op === "glob" ? globFiles(targets, pattern, opts) : grepFiles(targets, pattern, opts)).then(
  (result) => parentPort?.postMessage({ ok: true, result }),
  (e: unknown) => parentPort?.postMessage(e instanceof FolderError ? { ok: false, code: e.code, message: e.message } : { ok: false, code: "failed", message: "The search failed." }),
);
