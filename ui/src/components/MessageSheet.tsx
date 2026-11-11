import { Copy, Pencil } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ICON, STROKE } from "./kit.tsx";

type Props = {
  /** Edit is shown always for your own message; off with a reason while it can't be used. */
  editDisabled: string | null;
  onEdit: () => void;
  onCopy: () => void;
  onClose: () => void;
};

/** The phone's menu for one of your messages, opened by a long press: Edit and Copy, at the bottom of the screen. */
export function MessageSheet({ editDisabled, onEdit, onCopy, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  // The finger that opened the sheet is still lifting: a tap that lands right away is that finger, not a choice.
  const openedAt = useRef(Date.now());
  const pick = (fn: () => void) => () => {
    if (Date.now() - openedAt.current < 350) return;
    onClose();
    fn();
  };
  return createPortal(
    <div className="sheet-overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="menu" aria-label="Message actions">
        <button type="button" role="menuitem" className="sheet-item" disabled={!!editDisabled} onClick={pick(onEdit)}>
          <Pencil size={ICON} strokeWidth={STROKE} aria-hidden /> Edit
          {editDisabled && <span className="small muted sheet-hint">{editDisabled}</span>}
        </button>
        <button type="button" role="menuitem" className="sheet-item" onClick={pick(onCopy)}>
          <Copy size={ICON} strokeWidth={STROKE} aria-hidden /> Copy
        </button>
        <button type="button" className="sheet-item cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
}
