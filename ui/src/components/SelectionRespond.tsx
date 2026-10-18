import { LIMITS } from "@mc/shared";
import { CornerUpLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ICON_SM, STROKE } from "./kit.tsx";

/** Put on the bubble of every finished AI answer: only text selected inside one of these gets the menu. */
export const ANSWER_ATTR = "data-answer-id";

type Pick = { messageId: string; text: string; x: number; y: number; below: boolean };

/** One line of the selection, cut at a word so it still reads as a quote. */
function excerpt(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length <= LIMITS.quoteChars) return text;
  const cut = text.slice(0, LIMITS.quoteChars - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function readSelection(): Pick | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const answerOf = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest(`[${ANSWER_ATTR}]`) ?? null;
  const start = answerOf(range.startContainer);
  if (!start || start !== answerOf(range.endContainer)) return null; // inside one answer only
  const text = excerpt(sel.toString());
  const rect = range.getBoundingClientRect();
  if (!text || (rect.width === 0 && rect.height === 0)) return null;
  const below = rect.top < 56; // no room above: open under the selection
  return { messageId: start.getAttribute(ANSWER_ATTR)!, text, x: Math.max(70, Math.min(rect.left + rect.width / 2, window.innerWidth - 70)), y: below ? rect.bottom : rect.top, below };
}

/**
 * A small "Respond" menu next to text selected inside an AI answer. It never takes the selection away, so plain
 * Copy keeps working; it stays hidden while the mouse is still selecting, and goes on scroll, resize, Escape or a new selection.
 */
export function SelectionRespond({ onRespond }: { onRespond: (messageId: string, quote: string) => void }) {
  const [pick, setPick] = useState<Pick | null>(null);
  const selecting = useRef(false);

  useEffect(() => {
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setPick(selecting.current ? null : readSelection()));
    };
    const hide = () => setPick(null);
    const down = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".selection-menu")) return;
      selecting.current = true;
      setPick(null);
    };
    const up = () => {
      selecting.current = false;
      later();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setPick(null);
    document.addEventListener("selectionchange", later);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", later);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  if (!pick) return null;
  return createPortal(
    <div className={`selection-menu ${pick.below ? "below" : ""}`} role="toolbar" aria-label="Selected text" style={{ left: pick.x, top: pick.y }}>
      <button
        type="button"
        className="selection-respond"
        aria-label="Respond to the selected text"
        onMouseDown={(e) => e.preventDefault()} // keep the selection, so Copy still works
        onClick={() => {
          onRespond(pick.messageId, pick.text);
          window.getSelection()?.removeAllRanges();
          setPick(null);
        }}
      >
        <CornerUpLeft size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Respond
      </button>
    </div>,
    document.body,
  );
}
