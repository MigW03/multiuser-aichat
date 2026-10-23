import type { DesignAiEvent, DesignSavedEvent } from "@mc/shared";
import { admin } from "./supabase.ts";

// Hints on the project's realtime channel (`project:<id>`, members only) so open canvases reload a design that someone or
// the AI saved, and pause while the AI writes one. Nothing is decided from them: the canvas re-reads the file.

async function send(projectId: string, event: string, payload: object): Promise<void> {
  const channel = admin.channel(`project:${projectId}`, { config: { private: true } });
  try {
    await channel.httpSend(event, payload);
  } catch (e) {
    console.error(`[design] could not send ${event}:`, e instanceof Error ? e.message : e);
  } finally {
    await admin.removeChannel(channel).catch(() => undefined);
  }
}

export const designSaved = (projectId: string, e: DesignSavedEvent) => send(projectId, "design_saved", e);
export const designAi = (projectId: string, e: DesignAiEvent) => send(projectId, "design_ai", e);
