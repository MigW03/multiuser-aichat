import { designMarker, isDesignPath, type DesignAiEvent, type DesignRef } from "@mc/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesignCtx } from "../../data.tsx";
import { focusComposer } from "../../lib/designBus.ts";
import { summarizeEdits } from "../../lib/designEditor.ts";
import { joinProject, onProjectEvent } from "../../lib/projectChannel.ts";
import { DesignPicker, NewDesignDialog } from "./DesignDialogs.tsx";

/** The open design: which file, filling the main panel or beside the chat, and what the last request to open it asked for. */
export type DesignOpen = { path: string; full: boolean; n: number; select?: string[]; build?: boolean };

/**
 * Design mode's state for the whole page: which design is open, what the next chat message is about (the chip), and the
 * canvas edits not yet told to the AI. The panel, the chat, the files column and Cmd+K all go through it.
 */
export function useDesignMode({ projectId, userId, available, folders, onOpening }: { projectId: string | null; userId: string; available: boolean; folders: string[]; onOpening: () => void }) {
  const [open, setOpen] = useState<DesignOpen | null>(null);
  const [chip, setChip] = useState<DesignRef | null>(null);
  const [dialog, setDialog] = useState<"pick" | "new" | null>(null);
  const edits = useRef(new Map<string, string[]>());
  const opening = useRef(onOpening);
  opening.current = onOpening;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    setOpen(null);
    setChip(null);
    setDialog(null);
    edits.current.clear();
  }, [projectId]);

  const show = useCallback((path: string, opts?: { select?: string[]; build?: boolean }) => {
    if (!isDesignPath(path)) return;
    opening.current();
    setOpen((cur) => ({ path, full: cur?.full ?? false, n: (cur?.n ?? 0) + 1, ...(opts?.select ? { select: opts.select } : {}), ...(opts?.build ? { build: true } : {}) }));
    setChip((c) => (c?.path === path ? c : { path }));
    setDialog(null);
  }, []);

  const close = useCallback(() => {
    const was = openRef.current?.path;
    setOpen(null);
    setChip((c) => (c && c.path === was ? null : c));
  }, []);

  // The person who asked the AI for a design sees it drawn: the canvas opens for them when the AI starts writing.
  useEffect(() => {
    if (!projectId) return;
    const leave = joinProject(projectId, userId);
    const off = onProjectEvent(projectId, "design_ai", (p) => {
      const e = p as Partial<DesignAiEvent>;
      if (e.state === "start" && e.by === userId && isDesignPath(e.path) && openRef.current?.path !== e.path) show(e.path);
    });
    return () => {
      off();
      leave();
    };
  }, [projectId, userId, show]);

  const logEdit = useCallback((path: string, desc: string) => {
    const list = edits.current.get(path) ?? [];
    list.push(desc);
    edits.current.set(path, list.slice(-40));
  }, []);

  const take = useCallback((): string | null => {
    const c = chip;
    if (!c) return null;
    const pending = c.path ? edits.current.get(c.path) : undefined;
    if (c.path) edits.current.delete(c.path);
    const marker = designMarker({ ...c, ...(pending?.length ? { edits: summarizeEdits(pending) } : {}) });
    // The selection goes with one message; the open design stays the subject of the next ones.
    const still = openRef.current?.path;
    setChip(still ? { path: still } : null);
    return marker;
  }, [chip]);

  const ctx = useMemo<DesignCtx>(
    () => ({
      available: available && !!projectId,
      path: open?.path ?? null,
      open: show,
      pick: () => setDialog("pick"),
      create: () => setDialog("new"),
      close,
      chip,
      setChip: (ref) => {
        setChip(ref);
        if (ref) requestAnimationFrame(focusComposer);
      },
      take,
    }),
    [available, projectId, open?.path, show, close, chip, take],
  );

  const dialogs =
    projectId && dialog === "pick" ? (
      <DesignPicker projectId={projectId} current={open?.path ?? null} onOpen={(p) => show(p)} onNew={() => setDialog("new")} onClose={() => setDialog(null)} />
    ) : projectId && dialog === "new" ? (
      <NewDesignDialog projectId={projectId} folders={folders} onCreated={(p) => show(p)} onClose={() => setDialog(null)} />
    ) : null;

  return { ctx, open, setOpen, logEdit, dialogs };
}
