import type { DesignAiEvent, DesignSavedEvent } from "@mc/shared";
import { admin } from "./supabase.ts";

// Hints on the project's realtime channel (`project:<id>`, members only) so open canvases reload a design that someone or
// the AI saved, and pause while the AI writes one. Nothing is decided from them: the canvas re-reads the file.

/** Hints for one project go out one after another, so "done" never overtakes the "start" before it. */
const queues = new Map<string, Promise<void>>();
let seq = 0;

function send(projectId: string, event: string, payload: object): Promise<void> {
  const next = (queues.get(projectId) ?? Promise.resolve()).then(() => post(projectId, event, payload));
  queues.set(projectId, next);
  void next.then(() => {
    if (queues.get(projectId) === next) queues.delete(projectId);
  });
  return next;
}

async function post(projectId: string, event: string, payload: object): Promise<void> {
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
// Based on the clock, so it still grows after the server restarts while a canvas stays open.
export const designAi = (projectId: string, e: DesignAiEvent) => send(projectId, "design_ai", { ...e, seq: (seq = Math.max(seq + 1, Date.now())) });
