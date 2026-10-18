// Tests only: lets a worker thread load folder-worker.ts from source. The app runs the bundled dist/folder-worker.cjs.
import { register } from "tsx/esm/api";

register();
await import("./folder-worker.ts");
