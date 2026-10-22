import type { SmartKeyStatus } from "@mc/shared";
import { getUserKey } from "./keys.ts";
import { getOpenRouterUsage } from "./openrouter-usage.ts";
import { ProviderError } from "./provider-error.ts";
import { cleanSmartSet, creditStatus } from "./smart-rules.ts";
import { admin } from "./supabase.ts";

// Smart model selection. When a person picks "Auto", their message goes to OpenRouter's Jev Router with their own Smart
// set as the pool; the router chooses which model answers. It is a personal setting: one switch and one set per person.

export type SmartState = { enabled: boolean; models: string[] };

/** This person's switch and set. A database failure throws, so it is never mistaken for "off". */
export async function getSmart(userId: string): Promise<SmartState> {
  const { data, error } = await admin.from("user_smart_settings").select("enabled, models").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`could not read Smart settings: ${error.message}`);
  return { enabled: data?.enabled === true, models: cleanSmartSet(data?.models) ?? [] };
}

export async function saveSmartSet(userId: string, models: string[]): Promise<void> {
  const { error } = await admin.from("user_smart_settings").upsert({ user_id: userId, models, updated_at: new Date().toISOString() });
  if (error) throw new Error(`could not save the Smart set: ${error.message}`);
}

export async function setSmartOn(userId: string, enabled: boolean): Promise<void> {
  const { error } = await admin.from("user_smart_settings").upsert({ user_id: userId, enabled, updated_at: new Date().toISOString() });
  if (error) throw new Error(`could not save the Smart switch: ${error.message}`);
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
