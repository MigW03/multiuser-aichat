import { parsePreviewUrl, PREVIEW_PORTS, previewLabel } from "@mc/shared";
import { ArrowLeft, ArrowRight, ChevronLeft, ExternalLink, FileText, Maximize2, Minimize2, MoreHorizontal, RotateCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { FLOATING, intersects, usePreviewState, type PreviewBridge, type Rect } from "../lib/preview.ts";
import { Button, ICON, ICON_SM, IconButton, Menu, Spinner, STROKE, useToast } from "./kit.tsx";

/** Least width, in px, the preview and the chat each keep when they share the main panel. */
export const PREVIEW_MIN = 320;
const RETRY_MS = 3000;
const BAD_ADDRESS = "Only localhost addresses: localhost, 127.0.0.1 or [::1], on any port.";

/** The preview's width, in px, for a main panel `room` px wide: kept so the chat keeps its minimum. */
export function clampPreviewWidth(value: unknown, room: number): number {
  const max = Math.max(PREVIEW_MIN, room - PREVIEW_MIN);
  const n = typeof value === "number" && Number.isFinite(value) ? value : Math.round(room * 0.55);
  return Math.round(Math.min(max, Math.max(PREVIEW_MIN, n)));
}

const rectOf = (el: HTMLElement): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};
const sameRect = (a: Rect | null, b: Rect) => !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * A web page from this computer, shown beside the chat (or filling the main panel). The page itself is drawn by the desktop
 * app in a browser view laid over `.preview-body`; this component keeps that view on the body's rectangle, steps it aside
 * while a dialog or menu needs the space, and shows the states a browser view cannot: nothing typed yet, nothing running at
 * the address.
 */
export function PreviewPanel({
  bridge,
  url,
  remembered,
  full,
  narrow,
  runPath,
  onNavigate,
  onFull,
  onClose,
  onShowFile,
}: {
  bridge: PreviewBridge;
  /** The address to show; null until one is chosen. */
  url: string | null;
  /** The address used last in this project, offered in the empty state. */
  remembered: string | null;
  full: boolean;
  narrow: boolean;
  /** Set when this is a shared HTML file running ("Run page"): the shared path of the file. The address is then fixed and not an address to type. */
  runPath?: string;
  /** An address the app opened (the one to remember). */
  onNavigate: (url: string) => void;
  onFull: (full: boolean) => void;
  onClose: () => void;
  /** A running file: go back to the static view of the file. */
  onShowFile?: () => void;
}) {
  const toast = useToast();
  const state = usePreviewState(bridge);
  const body = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(url ? previewLabel(url) : remembered ? previewLabel(remembered) : "");
  const [editing, setEditing] = useState(url === null);
  const [bad, setBad] = useState<string | null>(null);
  const [running, setRunning] = useState<number[] | null>(null);
  const [covered, setCovered] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const last = useRef<Rect | null>(null);
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  const shown = url !== null && state !== null;
  const failed = shown ? state.error : null;

  // Open the address the page asked for.
  useEffect(() => {
    if (url === null || !body.current) return;
    let live = true;
    const rect = rectOf(body.current);
    last.current = rect;
    void bridge.open(url, rect).then(
      (r) => {
        if (!live) return;
        if (r.ok && r.url) {
          setBad(null);
          setDraft(previewLabel(r.url));
          onNavigateRef.current(r.url);
        } else setBad(BAD_ADDRESS);
      },
      () => live && setBad("The preview could not open."),
    );
    return () => {
      live = false;
    };
  }, [bridge, url]);

  // The preview goes when this panel does.
  useEffect(() => () => bridge.close(), [bridge]);

  // The address bar follows the page (links followed inside it) unless it is being edited.
  useEffect(() => {
    if (state?.url && !editing) setDraft(previewLabel(state.url));
  }, [state?.url, editing]);

  // Keep the view on the body's rectangle. Layout changes that move it without resizing it (a panel collapsing) fire no
  // event, so it is compared every frame while the panel is open.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const el = body.current;
      if (el) {
        const rect = rectOf(el);
        if (!sameRect(last.current, rect)) {
          last.current = rect;
          bridge.setBounds(rect);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [bridge]);

  // The view floats above the page: while a dialog, menu or notice reaches it, it steps aside.
  const checkCovered = useCallback(() => {
    const el = body.current;
    if (!el) return;
    const rect = rectOf(el);
    const hit = [...document.querySelectorAll<HTMLElement>(FLOATING)].some((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && intersects(rect, r);
    });
    setCovered(hit);
  }, []);
  useEffect(() => {
    let queued = false;
    const later = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        checkCovered();
      });
    };
    const observer = new MutationObserver(later);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener("resize", later);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", later);
    };
  }, [checkCovered]);

  const visible = shown && !failed && !covered;
  const wasVisible = useRef(true);
  useEffect(() => {
    if (!shown) return;
    if (visible === wasVisible.current) return;
    wasVisible.current = visible;
    if (visible) {
      void bridge.setVisible(true);
      setShot(null);
    } else {
      void bridge.setVisible(false).then((s) => setShot(failed ? null : s), () => undefined);
    }
  }, [bridge, shown, visible, failed]);

  // Nothing typed yet: look for dev servers that are running.
  useEffect(() => {
    if (url !== null) return;
    let live = true;
    const scan = () => void bridge.scan().then((p) => live && setRunning(p), () => live && setRunning([]));
    scan();
    const timer = setInterval(scan, RETRY_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [bridge, url]);

  // Nothing is running at the address: try again in the background.
  useEffect(() => {
    if (failed?.kind !== "refused") return;
    const timer = setInterval(() => bridge.reload(true), RETRY_MS);
    return () => clearInterval(timer);
  }, [bridge, failed?.kind]);

  const go = (text: string) => {
    const next = parsePreviewUrl(text);
    if (!next) return setBad(BAD_ADDRESS);
    setBad(null);
    setEditing(false);
    if (next === url) bridge.reload();
    else onNavigate(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go(draft);
  };

  const loading = shown && state.loading && !failed;
  const target = state?.url ?? url ?? "";

  return (
    <section className="chat-card preview-card" aria-label="Preview">
      <header className="preview-bar">
        {narrow && (
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Back to the chat">
            <ChevronLeft size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Chat
          </Button>
        )}
        {url !== null && (
          <>
            <IconButton label="Back" disabled={!shown || !state.canBack} onClick={() => bridge.back()}>
              <ArrowLeft size={ICON} strokeWidth={STROKE} />
            </IconButton>
            <IconButton label="Forward" disabled={!shown || !state.canForward} onClick={() => bridge.forward()}>
              <ArrowRight size={ICON} strokeWidth={STROKE} />
            </IconButton>
            <IconButton label="Reload" disabled={!shown} onClick={() => bridge.reload()}>
              {loading ? <Spinner /> : <RotateCw size={ICON} strokeWidth={STROKE} />}
            </IconButton>
          </>
        )}
        {runPath !== undefined ? (
          <div className="preview-address">
            <div className="preview-input readonly truncate" title={runPath}>
              Run · {runPath}
            </div>
          </div>
        ) : (
          <form className="preview-address" onSubmit={submit}>
            <input
              className={`preview-input ${bad ? "invalid" : ""}`}
              value={draft}
              placeholder="localhost:5173"
              aria-label="Address"
              aria-invalid={bad ? true : undefined}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoFocus={url === null}
              onFocus={(e) => {
                setEditing(true);
                e.currentTarget.select();
              }}
              onBlur={() => setEditing(false)}
              onChange={(e) => {
                setDraft(e.target.value);
                setBad(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setDraft(state?.url ? previewLabel(state.url) : "");
                  e.currentTarget.blur();
                }
              }}
            />
          </form>
        )}
        {runPath !== undefined && onShowFile && (
          <IconButton label="Show the file" onClick={onShowFile}>
            <FileText size={ICON} strokeWidth={STROKE} />
          </IconButton>
        )}
        {url !== null && runPath === undefined && (
          <IconButton label="Open in my browser" disabled={!shown} onClick={() => bridge.openExternal()}>
            <ExternalLink size={ICON} strokeWidth={STROKE} />
          </IconButton>
        )}
        {!narrow && (
          <IconButton label={full ? "Show the chat beside it" : "Fill the main panel"} onClick={() => onFull(!full)}>
            {full ? <Minimize2 size={ICON} strokeWidth={STROKE} /> : <Maximize2 size={ICON} strokeWidth={STROKE} />}
          </IconButton>
        )}
        {runPath === undefined && (
          <Menu
            label="Preview options"
            align="end"
            items={[
              {
                label: "Forget this site's cookies and data",
                icon: <Trash2 size={ICON_SM} strokeWidth={STROKE} aria-hidden />,
                onSelect: () =>
                  void bridge.clearData().then(
                    () => {
                      toast.push("Cookies and data of the previewed site are gone");
                      if (url !== null) bridge.reload();
                    },
                    () => toast.push("Could not clear them", "error"),
                  ),
              },
            ]}
            trigger={({ toggle, open }) => (
              <IconButton label="Preview options" onClick={toggle} active={open} aria-haspopup="menu" aria-expanded={open}>
                <MoreHorizontal size={ICON} strokeWidth={STROKE} />
              </IconButton>
            )}
          />
        )}
        {!narrow && (
          <IconButton label="Close the preview" onClick={onClose}>
            <X size={ICON} strokeWidth={STROKE} />
          </IconButton>
        )}
      </header>
      {runPath !== undefined && <div className="preview-note small muted">Scripts run. The network is off. Only run files you trust.</div>}
      {bad && (
        <div className="preview-note error-line" role="alert">
          {bad}
        </div>
      )}
      <div className="preview-body" ref={body}>
        {url === null && (
          <div className="preview-empty">
            <p className="strong">Preview a page from this computer</p>
            <p className="muted small">Type an address above, for example localhost:5173. Only localhost addresses open here.</p>
            {running !== null && (
              <div className="preview-ports">
                {running.length > 0 ? (
                  <>
                    <span className="small muted">Running now</span>
                    <div className="preview-chips">
                      {running.map((p) => (
                        <button key={p} type="button" className="btn secondary sm" onClick={() => go(String(p))}>
                          <span className="status-dot on" aria-hidden /> localhost:{p}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <span className="small muted">Nothing found on {PREVIEW_PORTS.join(", ")}. Start your dev server and it shows up here.</span>
                )}
              </div>
            )}
            {remembered && (
              <Button size="sm" onClick={() => go(remembered)}>
                Open {previewLabel(remembered)} again
              </Button>
            )}
          </div>
        )}
        {url !== null && failed && (
          <div className="preview-empty">
            {failed.kind === "refused" ? (
              <>
                <p className="strong">Nothing is running at {previewLabel(target)}</p>
                <p className="muted small">Start your dev server. This tries again by itself.</p>
              </>
            ) : (
              <>
                <p className="strong">This page did not load</p>
                <p className="muted small">{failed.text}</p>
              </>
            )}
            <div className="preview-chips">
              <Button size="sm" onClick={() => bridge.reload()}>
                Retry
              </Button>
              {runPath === undefined && (
                <Button size="sm" variant="ghost" onClick={() => bridge.openExternal()}>
                  <ExternalLink size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Open in my browser
                </Button>
              )}
            </div>
          </div>
        )}
        {url !== null && !failed && shot && covered && <img className="preview-shot" src={shot} alt="" />}
      </div>
    </section>
  );
}

/** The drag handle on the preview's left edge (beside the chat). Arrow keys resize too; double-click goes back to the default. */
export function PreviewResizer({ width, room, onChange }: { width: number; room: number; onChange: (next: number, remember: boolean) => void }) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);
  const max = Math.max(PREVIEW_MIN, room - PREVIEW_MIN);
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width };
    setDragging(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current) onChange(start.current.width - (e.clientX - start.current.x), false);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    onChange(start.current.width - (e.clientX - start.current.x), true);
    start.current = null;
    setDragging(false);
  };
  return (
    <div
      className={`panel-resizer right ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the preview"
      aria-valuemin={PREVIEW_MIN}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onChange(Math.round(room * 0.55), true)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        const next =
          e.key === "ArrowLeft" ? width + step : e.key === "ArrowRight" ? width - step : e.key === "Home" ? PREVIEW_MIN : e.key === "End" ? max : null;
        if (next === null) return;
        e.preventDefault();
        onChange(next, true);
      }}
    />
  );
}
