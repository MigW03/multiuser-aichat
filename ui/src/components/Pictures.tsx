import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePictureUrl } from "../lib/pictureUrls.ts";
import { ICON, STROKE } from "./kit.tsx";

/** The pictures of a message. Click one to see it full size. */
export function PictureGrid({ chatId, ids }: { chatId: string; ids: string[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className={`pics ${ids.length === 1 ? "one" : ""}`}>
        {ids.map((id) => (
          <PictureTile key={id} chatId={chatId} id={id} onOpen={() => setOpen(id)} />
        ))}
      </div>
      {open && <Lightbox chatId={chatId} id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function PictureTile({ chatId, id, onOpen }: { chatId: string; id: string; onOpen: () => void }) {
  const { url, failed } = usePictureUrl(chatId, id);
  if (failed) return <span className="pic gone">Picture not available</span>;
  return (
    <button type="button" className="pic" onClick={onOpen} disabled={!url} aria-label="View picture full size">
      {url ? <img src={url} alt="Picture sent in the chat" draggable={false} /> : <span className="pic-wait" aria-hidden />}
    </button>
  );
}

/** Full-size view: close with the button, Esc, or a click outside the picture. */
function Lightbox({ chatId, id, onClose }: { chatId: string; id: string; onClose: () => void }) {
  const { url } = usePictureUrl(chatId, id);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Picture" onClick={onClose}>
      <button ref={closeRef} type="button" className="lightbox-close" aria-label="Close picture" onClick={onClose}>
        <X size={ICON} strokeWidth={STROKE} />
      </button>
      {url ? <img src={url} alt="Picture sent in the chat" onClick={(e) => e.stopPropagation()} /> : <span className="pic-wait" aria-hidden />}
    </div>,
    document.body,
  );
}
