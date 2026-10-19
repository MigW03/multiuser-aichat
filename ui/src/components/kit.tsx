import { Info, Sparkles } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export const ICON = 16;
export const ICON_SM = 14;
export const STROKE = 1.75;

// ------------------------------------------------------------------ buttons

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
  busy?: boolean;
  block?: boolean;
};

export function Button({ variant = "secondary", size = "md", busy, block, className = "", children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={`btn ${variant} ${size} ${block ? "block" : ""} ${className}`} disabled={disabled || busy} {...rest}>
      {busy ? <span className="spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  shortcut,
  active,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; shortcut?: { label: string; keys: string } }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-keyshortcuts={shortcut?.keys}
      title={shortcut ? `${label} (${shortcut.label})` : label}
      className={`icon-btn ${active ? "active" : ""} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

// ------------------------------------------------------------------ people

function hashIndex(id: string, mod: number) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % mod;
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0]![0]! + (parts.length > 1 ? parts.at(-1)![0]! : "")).toUpperCase();
}

/** People are gray; the gray is picked from the id so a person keeps theirs everywhere. */
export function Avatar({ id, name, size = 28, online, ring }: { id: string; name: string; size?: number; online?: boolean; ring?: boolean }) {
  const n = hashIndex(id, 3) + 1;
  return (
    <span
      className={`avatar ${ring ? "ring" : ""}`}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)), background: `var(--av${n}-bg)`, color: `var(--av${n}-fg)` }}
      title={name}
      aria-label={name}
    >
      {initials(name)}
      {online !== undefined && <span className={`presence ${online ? "on" : ""}`} aria-label={online ? "Online" : "Offline"} />}
    </span>
  );
}

export function AiAvatar({ size = 28 }: { size?: number }) {
  return (
    <span className="avatar claude" style={{ width: size, height: size }} aria-label="AI">
      <Sparkles size={Math.round(size * 0.5)} strokeWidth={2} aria-hidden />
    </span>
  );
}

/** Gray pill for people, steel pill with a spark for the AI. When both are new, the AI pill wins. */
export function UnreadBadge({ people, ai }: { people: number; ai: number }) {
  if (people + ai <= 0) return null;
  const count = people + ai;
  const text = count > 99 ? "99+" : String(count);
  if (ai > 0) {
    return (
      <span className="badge ai" aria-label={`${count} unread, including the AI`}>
        <Sparkles size={9} strokeWidth={2.2} aria-hidden />
        {text}
      </span>
    );
  }
  return (
    <span className="badge people" aria-label={`${count} unread`}>
      {text}
    </span>
  );
}

// ------------------------------------------------------------------ info tip

/**
 * A small info icon whose text floats beside it on hover, keyboard focus or a tap. The text is rendered in a portal
 * with fixed positioning, so a card with overflow hidden can't clip it.
 */
export function InfoTip({ label, children, size = ICON_SM }: { label: string; children: ReactNode; size?: number }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const id = useId();
  const WIDTH = 260;

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(8, r.right - WIDTH), window.innerWidth - WIDTH - 8);
    setPos({ top: r.bottom + 6, left });
    setOpen(true);
  };
  const hide = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    const onScroll = () => hide();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="icon-btn sm info-tip-btn"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => (open ? hide() : show())}
      >
        <Info size={size} strokeWidth={STROKE} aria-hidden />
      </button>
      {open &&
        pos &&
        createPortal(
          <div id={id} role="tooltip" className="info-tip" style={{ top: pos.top, left: pos.left, width: WIDTH }}>
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * A short hint that floats below its content on hover or keyboard focus. Rendered in a portal like InfoTip, because the
 * desktop app doesn't show the browser's own title tooltips reliably.
 */
export function Tip({ text, children, className = "" }: { text: string; children: ReactNode; className?: string }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  const WIDTH = 220;
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ top: r.bottom + 6, left: Math.min(Math.max(8, r.right - WIDTH), window.innerWidth - WIDTH - 8) });
  };
  const hide = () => setPos(null);
  return (
    <>
      <span ref={ref} className={className} tabIndex={0} aria-describedby={pos ? id : undefined} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onKeyDown={(e) => e.key === "Escape" && hide()}>
        {children}
      </span>
      {pos &&
        createPortal(
          <div id={id} role="tooltip" className="info-tip" style={{ top: pos.top, left: pos.left, width: WIDTH }}>
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}

// ------------------------------------------------------------------ dialogs

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])';

export function Dialog({
  title,
  onClose,
  width = 440,
  children,
  footer,
  label,
  dismissable = true,
}: {
  title?: ReactNode;
  onClose: () => void;
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
  label?: string;
  dismissable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>("[data-autofocus]") ?? node?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && dismissable) {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab" && node) {
        const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) return;
        const firstEl = items[0]!;
        const lastEl = items.at(-1)!;
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [dismissable]);

  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && dismissable && onClose()}>
      <div ref={ref} className="dialog" style={{ width }} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} aria-label={title ? undefined : label}>
        {title ? (
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
        ) : null}
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ menus

export type MenuItem =
  | { label: string; onSelect: () => void; icon?: ReactNode; danger?: boolean; disabled?: boolean; checked?: boolean; title?: string }
  | "divider";

/** A button that opens a small menu. Closes on outside click, Escape and selection. */
export function Menu({
  trigger,
  items,
  align = "start",
  placement = "below",
  label,
  className = "",
  width,
}: {
  trigger: (props: { open: boolean; toggle: () => void; id: string }) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  placement?: "below" | "above";
  label: string;
  className?: string;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`menu-wrap ${className}`} ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o), id })}
      {open && (
        <div className={`menu ${align} ${placement}`} role="menu" aria-label={label} style={width ? { minWidth: width } : undefined}>
          {items.map((item, i) =>
            item === "divider" ? (
              <div key={i} className="menu-divider" role="separator" />
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                className={`menu-item ${item.danger ? "danger" : ""}`}
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.icon}
                <span className="grow">{item.label}</span>
                {item.checked ? <span className="menu-check">✓</span> : null}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ forms

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

export function TextInput({ invalid, className = "", ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={`input ${invalid ? "invalid" : ""} ${className}`} {...rest} />;
}

// ------------------------------------------------------------------ toasts

type Toast = { id: number; text: string; kind: "info" | "error" };
const ToastContext = createContext<{ push: (text: string, kind?: Toast["kind"]) => void }>({ push: () => {} });
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = next.current++;
    setToasts((cur) => [...cur.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), kind === "error" ? 7000 : 4000);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ------------------------------------------------------------------ misc

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="section-label">
      <span>{children}</span>
      {action}
    </div>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return children ? (
    <div className="error-line" role="alert">
      {children}
    </div>
  ) : null;
}
