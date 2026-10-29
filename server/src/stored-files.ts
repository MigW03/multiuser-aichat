import { projectPrefix, sharePrefix } from "./file-paths.ts";
import { designPrefix } from "./project-designs.ts";
import { objectStore, storageOn } from "./r2.ts";

// Removes stored copies of files when what they belong to goes away. Best effort: the database change has already
// happened, and a copy that stays behind can't be reached (reads check that the item is still approved).

async function drop(prefix: () => string, what: string): Promise<void> {
  if (!storageOn()) return;
  try {
    await objectStore().removePrefix(prefix());
  } catch (e) {
    console.error(`[files] could not remove the stored files of ${what}:`, e instanceof Error ? e.message : e);
  }
}

export const dropShareFiles = (projectId: string, shareId: string) => drop(() => sharePrefix(projectId, shareId), "a shared item");
export const dropProjectFiles = (projectId: string) => drop(() => projectPrefix(projectId), "a project");
/** A project's designs (designs/<project>/, see project-designs.ts). */
export const dropProjectDesigns = (projectId: string) => drop(() => designPrefix(projectId), "a project's designs");
