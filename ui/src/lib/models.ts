import { fitReasoning, type ModelChoice, type ModelInfo, type ProviderId, type Reasoning } from "@mc/shared";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { supabase } from "../supabase.ts";

const TTL_MS = 5 * 60_000;
const cache = new Map<ProviderId, { at: number; models: Promise<ModelInfo[]> }>();

/** One model list per provider, shared by the pickers and the thinking menu so opening them does not refetch. */
export function loadModels(provider: ProviderId): Promise<ModelInfo[]> {
  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.models;
  const models = api.models(provider).then((r) => r.models);
  cache.set(provider, { at: Date.now(), models });
  models.catch(() => cache.get(provider)?.models === models && cache.delete(provider));
  return models;
}

// Another person signing in on the same tab must not see lists fetched with the last person's keys.
supabase.auth.onAuthStateChange((event) => (event === "SIGNED_IN" || event === "SIGNED_OUT") && cache.clear());

export function forgetModels(provider: ProviderId) {
  cache.delete(provider);
}

/** What the chosen model offers for thinking. `levels` is null while that is unknown (still loading, or the provider does not say). */
export function useModelReasoning(choice: ModelChoice | null): { levels: Reasoning[] | null; effective: Reasoning | null } {
  const [levels, setLevels] = useState<{ key: string; levels: Reasoning[] | null } | null>(null);
  const key = choice ? `${choice.provider}:${choice.model}` : null;
  useEffect(() => {
    if (!choice || !key) return;
    let live = true;
    loadModels(choice.provider).then(
      (models) => live && setLevels({ key, levels: models.find((m) => m.id === choice.model)?.reasoning ?? null }),
      () => live && setLevels({ key, levels: null }),
    );
    return () => {
      live = false;
    };
    // the model, not the whole choice: changing only the level must not refetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const known = levels && levels.key === key ? levels.levels : null;
  if (!choice) return { levels: null, effective: null };
  return { levels: known, effective: known ? fitReasoning(known, choice.reasoning) : choice.reasoning };
}
