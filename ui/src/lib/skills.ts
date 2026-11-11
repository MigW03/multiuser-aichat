import type { SkillsList } from "@mc/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";

// The lists of skills the page shows: the person's own and, with a project, that project's. Settings, the project's
// settings and the composer's "/" list all read the same data, and a change in one refreshes the others.

const listeners = new Set<() => void>();
/** Call after any change to a skill or plugin, so every list on the page reloads. */
export const notifySkillsChanged = () => listeners.forEach((f) => f());

export function useSkills(projectId?: string): { list: SkillsList | null; error: string | null; reload: () => void } {
  const [list, setList] = useState<SkillsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick((n) => n + 1);
    listeners.add(f);
    return () => void listeners.delete(f);
  }, []);
  useEffect(() => {
    let live = true;
    api
      .skills(projectId)
      .then((l) => {
        if (!live) return;
        setList(l);
        setError(null);
      })
      .catch((e) => live && setError(e instanceof Error && e.message ? e.message : "Could not load the skills."));
    return () => {
      live = false;
    };
  }, [projectId, tick]);
  return { list, error, reload: useCallback(() => notifySkillsChanged(), []) };
}
