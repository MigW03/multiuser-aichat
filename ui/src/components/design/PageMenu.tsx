import { ChevronDown, Copy, FileText, MoreHorizontal, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ICON_SM, STROKE } from "../kit.tsx";

// The page menu of a design: a dropdown at the top left of the canvas. It lists the pages (click to show one), adds a page,
// renames, duplicates and deletes (the "..." on a row, or double-click to rename) and reorders by dragging a row. It only
// asks; the design panel changes the design and keeps it as one undo step.

type Props = {
  pages: string[];
  counts: Map<string, number>;
  current: string;
  readOnly: boolean;
  /** The page the AI is writing on, if any. */
  aiPage?: string | null;
  /** Grows to start renaming the current page (F2). */
  renameSignal: number;
  onSwitch: (page: string) => void;
  onAdd: (name: string) => void;
  onRename: (from: string, to: string) => void;
  onDuplicate: (page: string) => void;
  onDelete: (page: string) => void;
  onMove: (page: string, to: number) => void;
};

export function PageMenu({ pages, counts, current, readOnly, aiPage, renameSignal, onSwitch, onAdd, onRename, onDuplicate, onDelete, onMove }: Props) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ from: string; value: string } | null>(null);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ page: string; over: number | null } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const close = () => {
    setOpen(false);
    setAdding(null);
    setRenaming(null);
    setRowMenu(null);
    setDrag(null);
  };

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [open]);

  useEffect(() => {
    if (renameSignal > 0 && !readOnly) {
      setOpen(true);
      setRenaming({ from: current, value: current });
    }
    // only a new signal starts a rename
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameSignal]);

  const finishRename = () => {
    if (renaming && renaming.value.trim() && renaming.value.trim() !== renaming.from) onRename(renaming.from, renaming.value);
    setRenaming(null);
  };

  return (
    <div
      className="dz-page-wrap"
      ref={wrap}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button type="button" className="dz-page-btn" aria-haspopup="menu" aria-expanded={open} title="Pages" onClick={() => (open ? close() : setOpen(true))}>
        <FileText size={ICON_SM} strokeWidth={STROKE} aria-hidden />
        <span className="truncate">{current}</span>
        <ChevronDown size={ICON_SM} strokeWidth={STROKE} aria-hidden />
      </button>
      {open && (
        <div className="menu dz-page-menu" role="menu" aria-label="Pages">
          {pages.map((page, i) => (
            <div key={page}>
              <div
                className={`dz-page-row ${page === current ? "on" : ""} ${drag?.over === i && drag.page !== page ? "over" : ""} ${drag?.page === page ? "dragging" : ""}`}
                draggable={!readOnly && renaming === null}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", page);
                  setDrag({ page, over: null });
                }}
                onDragOver={(e) => {
                  if (!drag) return;
                  e.preventDefault();
                  if (drag.over !== i) setDrag({ ...drag, over: i });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag && drag.page !== page) onMove(drag.page, i);
                  setDrag(null);
                }}
                onDragEnd={() => setDrag(null)}
              >
                {renaming?.from === page ? (
                  <input
                    className="dz-page-input"
                    value={renaming.value}
                    maxLength={40}
                    aria-label="Page name"
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setRenaming({ from: page, value: e.target.value })}
                    onBlur={finishRename}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") finishRename();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    className="dz-page-pick"
                    onClick={() => {
                      onSwitch(page);
                      // A double-click renames, so the menu closes a moment after a single click.
                      window.clearTimeout(closeTimer.current);
                      closeTimer.current = window.setTimeout(close, readOnly ? 0 : 250);
                    }}
                    onDoubleClick={() => {
                      window.clearTimeout(closeTimer.current);
                      if (!readOnly) setRenaming({ from: page, value: page });
                    }}
                    onContextMenu={(e) => {
                      if (readOnly) return;
                      e.preventDefault();
                      setRowMenu(page);
                    }}
                  >
                    <span className="truncate">{page}</span>
                    {aiPage === page && (
                      <span className="small muted" title="The AI is writing on this page">
                        <Sparkles size={ICON_SM} strokeWidth={STROKE} aria-label="The AI is writing here" />
                      </span>
                    )}
                    <span className="small muted dz-page-count">{counts.get(page) ?? 0}</span>
                  </button>
                )}
                {!readOnly && renaming?.from !== page && (
                  <button type="button" className="dz-page-more" aria-label={`Options for ${page}`} aria-expanded={rowMenu === page} onClick={() => setRowMenu(rowMenu === page ? null : page)}>
                    <MoreHorizontal size={ICON_SM} strokeWidth={STROKE} />
                  </button>
                )}
              </div>
              {rowMenu === page && (
                <div className="dz-page-sub">
                  <button type="button" role="menuitem" className="menu-item" onClick={() => (setRowMenu(null), setRenaming({ from: page, value: page }))}>
                    <Pencil size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Rename
                  </button>
                  <button type="button" role="menuitem" className="menu-item" onClick={() => (close(), onDuplicate(page))}>
                    <Copy size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Duplicate
                  </button>
                  <button type="button" role="menuitem" className="menu-item danger" disabled={pages.length < 2} title={pages.length < 2 ? "A design keeps at least one page" : undefined} onClick={() => (close(), onDelete(page))}>
                    <Trash2 size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Delete…
                  </button>
                </div>
              )}
            </div>
          ))}
          {!readOnly && <div className="menu-divider" />}
          {!readOnly &&
            (adding === null ? (
              <button type="button" role="menuitem" className="menu-item" onClick={() => setAdding("")}>
                <Plus size={ICON_SM} strokeWidth={STROKE} aria-hidden /> New page
              </button>
            ) : (
              <input
                className="dz-page-input"
                value={adding}
                maxLength={40}
                placeholder={`Page ${pages.length + 1}`}
                aria-label="New page name"
                autoFocus
                onChange={(e) => setAdding(e.target.value)}
                onBlur={() => setAdding(null)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    onAdd(adding);
                    close();
                  }
                  if (e.key === "Escape") setAdding(null);
                }}
              />
            ))}
        </div>
      )}
    </div>
  );
}
