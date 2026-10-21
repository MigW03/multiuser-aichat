import { LIMITS } from "@mc/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { useApp } from "../data.tsx";

// Smart model selection, as this person has it in one project: their own switch, and their own set of OpenRouter models.
// The settings page and the model picker both show it, so a change in one tells the other.

const bus = new EventTarget();
const announce = () => bus.dispatchEvent(new Event("change"));

type Loaded = { projectId: string; enabled: boolean; models: string[] };

export function useSmart(projectId: string | null) {
  const { keys } = useApp();
  const [state, setState] = useState<Loaded | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    bus.addEventListener("change", on);
    return () => bus.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    Promise.all([api.smartSettings(projectId), api.smartSet()]).then(
      ([s, set]) => live && setState({ projectId, enabled: s.enabled, models: set.models }),
      () => undefined, // the feature just stays hidden if the server can't say
    );
    return () => {
      live = false;
    };
  }, [projectId, tick]);

  const mine = state && state.projectId === projectId ? state : null;
  const hasKey = !!keys?.some((k) => k.provider === "openrouter");
  const models = mine?.models ?? [];
  const enabled = !!mine?.enabled && hasKey;

  /** Saves the set, showing it at once; puts it back if the server says no. */
  const setModels = useCallback(
    async (next: string[]) => {
      const before = state;
      setState((s) => (s ? { ...s, models: next } : s));
      try {
        await api.saveSmartSet(next);
        announce();
      } catch (e) {
        setState(before);
        throw e;
      }
    },
    [state],
  );

  return {
    loaded: !!mine,
    /** Switched on in this project, and an OpenRouter key exists to pay for it. */
    enabled,
    models,
    /** Auto can be used: it is on and the set is big enough for the router to choose. */
    ready: enabled && models.length >= LIMITS.smartMin,
    setModels,
  };
}

/** Tells every open picker and settings page to read the switch and the set again. */
export const smartChanged = announce;
