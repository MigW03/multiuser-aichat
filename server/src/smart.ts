import type { SmartKeyStatus } from "@mc/shared";
import { getUserKey } from "./keys.ts";
import { getOpenRouterUsage } from "./openrouter-usage.ts";
import { ProviderError } from "./provider-error.ts";
import { cleanSmartSet, creditStatus } from "./smart-rules.ts";
import { admin } from "./supabase.ts";

// Smart model selection. When a person picks "Auto", their message goes to OpenRouter's Jev Router with their own Smart
// set as the pool; the router chooses which model answers. Everything here is about that one person and their own key.

export async function getSmartSet(userId: string): Promise<string[]> {
  const { data } = await admin.from("user_smart_set").select("models").eq("user_id", userId).maybeSingle();
  return cleanSmartSet(data?.models) ?? [];
}

export async function saveSmartSet(userId: string, models: string[]): Promise<void> {
  const { error } = await admin.from("user_smart_set").upsert({ user_id: userId, models, updated_at: new Date().toISOString() });
  if (error) throw new Error("Could not save the Smart set");
}

/** Whether this person switched Smart model selection on in this project. Anyone not in the project has it off. */
export async function isSmartOn(userId: string, projectId: string): Promise<boolean> {
  const { data } = await admin.from("project_members").select("smart_selection").eq("project_id", projectId).eq("user_id", userId).maybeSingle();
  return data?.smart_selection === true;
}

export async function setSmartOn(userId: string, projectId: string, enabled: boolean): Promise<boolean> {
  const { data, error } = await admin.from("project_members").update({ smart_selection: enabled }).eq("project_id", projectId).eq("user_id", userId).select("user_id");
  return !error && (data?.length ?? 0) > 0;
}

/** Whether this person has an OpenRouter key that works, and as far as can be known, credit. */
export async function checkSmartKey(userId: string): Promise<SmartKeyStatus> {
  const apiKey = await getUserKey(userId, "openrouter");
  if (!apiKey) return "no_key";
  try {
    return creditStatus(await getOpenRouterUsage(userId, apiKey, true));
  } catch (e) {
    if (e instanceof ProviderError && /rejected this key/i.test(e.message)) return "invalid_key";
    return "unreachable";
  }
}
