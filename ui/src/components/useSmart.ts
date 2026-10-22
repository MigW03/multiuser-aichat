import { LIMITS, type SmartSettings } from "@mc/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { useApp } from "../data.tsx";

// Smart model selection, as this person has it: their own switch and set of OpenRouter models (Settings > AI key).
// The settings dialog and the model picker both show it, so a change in one tells the other.

const bus = new EventTarget();
const announce = () => bus.dispatchEvent(new Event("change"));

export function useSmart() {
  const { keys } = useApp();
  const [state, setState] = useState<Pick<SmartSettings, "enabled" | "models"> | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    bus.addEventListener("change", on);
    return () => bus.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    let live = true;
    api.smart().then(
      (s) => live && setState({ enabled: s.enabled, models: s.models }),
      () => undefined, // the feature just stays hidden if the server can't say
    );
    return () => {
      live = false;
    };
  }, [tick]);

  const hasKey = !!keys?.some((k) => k.provider === "openrouter");
  const models = state?.models ?? [];
  const enabled = !!state?.enabled && hasKey;

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
    loaded: !!state,
    /** Switched on, and an OpenRouter key exists to pay for it. */
    enabled,
    models,
    /** Auto can be used: it is on and the set is big enough for the router to choose. */
    ready: enabled && models.length >= LIMITS.smartMin,
    setModels,
  };
}

/** Tells every open picker and settings page to read the switch and the set again. */
export const smartChanged = announce;
