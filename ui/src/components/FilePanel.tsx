import type { FolderReadResult } from "@mc/shared";
import { ChevronLeft, Copy, RotateCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, ApiRequestError } from "../api.ts";
import { candidatePaths, dirOf, fileKind } from "../lib/fileKind.ts";
import { FRAME_SANDBOX, frameDocument } from "../lib/htmlFrame.ts";
import { Button, ICON, ICON_SM, IconButton, Spinner, STROKE, useToast } from "./kit.tsx";
import { Markdown } from "./Markdown.tsx";

/** What to show: `path` is exact, or (`guess`) as an answer wrote it and looked for under each shared folder. `n` changes with every open, so opening the same file again reads it again. */
export type FileRequest = { path: string; guess: boolean; n: number };

type Mode = "preview" | "source";
type Loaded = { path: string; result: FolderReadResult };

// The host says "not found" when a path is not there; for a guessed path the next folder is tried.
const MISSING = new Set(["not_found", "not_a_file", "invalid_path", "excluded"]);

/**
 * A shared file, in the middle of the main panel in place of the chat. Markdown and HTML files have a Preview (the default) and
 * the Source; everything else is shown as text. The chat stays mounted behind it.
 */
export function FilePanel({ projectId, request, folders, onClose }: { projectId: string; request: FileRequest; folders: string[]; onClose: () => void }) {
  const toast = useToast();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("preview");
  const [reload, setReload] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const scroll = useRef<Record<Mode, number>>({ preview: 0, source: 0 });
  const foldersKey = folders.join("\u0000");

  // Read the file (the host's app, through the server). Guessed paths are tried in order until one is there.
  useEffect(() => {
    let live = true;
    setError(null);
    setLoaded((cur) => (cur && cur.path === request.path ? cur : null));
    const paths = request.guess ? candidatePaths(request.path, foldersKey ? foldersKey.split("\u0000") : []) : [request.path];
    void (async () => {
      let last: unknown = null;
      for (const path of paths) {
        try {
          const result = await api.folderRead(projectId, path);
          if (live) setLoaded({ path, result });
          return;
        } catch (e) {
          last = e;
          if (!(e instanceof ApiRequestError && e.code && MISSING.has(e.code))) break;
        }
      }
      if (!live) return;
      setLoaded(null);
      setError(request.guess && last instanceof ApiRequestError && last.code && MISSING.has(last.code) ? `${request.path} is not in the shared files.` : last instanceof Error && last.message ? last.message : "The file could not be opened.");
    })();
    return () => {
      live = false;
    };
  }, [projectId, request.path, request.guess, request.n, reload, foldersKey]);

  const path = loaded?.path ?? request.path;
  const kind = fileKind(path);
  const name = path.split("/").at(-1) ?? path;
  const dir = dirOf(path);

  // Another file starts at the Preview, at the top.
  useEffect(() => {
    setMode("preview");
    scroll.current = { preview: 0, source: 0 };
  }, [request.path, request.n]);

  // Flipping between Preview and Source keeps where you were in each.
  const flip = (next: Mode) => {
    if (body.current) scroll.current[mode] = body.current.scrollTop;
    setMode(next);
  };
  const showing: Mode = kind === "text" ? "source" : mode;
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = scroll.current[showing];
  }, [showing, loaded]);

  // Esc goes back to the chat, unless something on top of the panel (a menu, a dialog) or a field has it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const text = loaded?.result.text ?? null;
  const frame = useMemo(() => (kind === "html" && text !== null ? frameDocument(text) : null), [kind, text]);

  const copy = () => {
    if (text === null) return;
    navigator.clipboard.writeText(text).then(
      () => toast.push("Copied"),
      () => toast.push("Could not copy.", "error"),
    );
  };

  return (
    <section className="chat-card file-card" aria-label={`File ${name}`}>
      <header className="preview-bar file-bar">
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Back to the chat" title="Back to the chat (Esc)">
          <ChevronLeft size={ICON_SM} strokeWidth={STROKE} aria-hidden /> Chat
        </Button>
        <div className="file-title truncate" title={path}>
          <b className="mono">{name}</b>
          {dir && <span className="small muted"> {dir}/</span>}
        </div>
        {kind !== "text" && loaded && (
          <div className="seg" role="group" aria-label="View">
            <button type="button" aria-pressed={showing === "preview"} className={showing === "preview" ? "on" : ""} onClick={() => flip("preview")}>
              Preview
            </button>
            <button type="button" aria-pressed={showing === "source"} className={showing === "source" ? "on" : ""} onClick={() => flip("source")}>
              Source
            </button>
          </div>
        )}
        <IconButton label="Read the file again" onClick={() => setReload((n) => n + 1)} disabled={!loaded && !error}>
          <RotateCw size={ICON} strokeWidth={STROKE} />
        </IconButton>
        <IconButton label="Copy the text" onClick={copy} disabled={text === null}>
          <Copy size={ICON} strokeWidth={STROKE} />
        </IconButton>
        <IconButton label="Close the file" onClick={onClose}>
          <X size={ICON} strokeWidth={STROKE} />
        </IconButton>
      </header>

      {kind === "html" && loaded && showing === "preview" && <div className="preview-note small muted">Static view. Scripts and content from the web are off.</div>}
      {loaded?.result.truncated && (
        <div className="preview-note small muted">
          Showing lines {loaded.result.startLine}–{loaded.result.endLine} of {loaded.result.totalLines}.
          {kind !== "text" ? " The Preview shows only this part." : ""}
        </div>
      )}

      <div className={`file-body ${showing === "preview" && kind === "html" ? "is-frame" : ""}`} ref={body}>
        {error ? (
          <div className="file-state">
            <p className="muted">{error}</p>
            <Button size="sm" onClick={() => setReload((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : !loaded ? (
          <div className="file-state muted small">
            <Spinner /> Opening {name}…
          </div>
        ) : showing === "preview" && kind === "markdown" ? (
          <div className="file-markdown">
            <Markdown text={loaded.result.text} fileDir={dir} />
          </div>
        ) : showing === "preview" && frame !== null ? (
          <iframe className="file-frame" title={`Preview of ${name}`} sandbox={FRAME_SANDBOX} referrerPolicy="no-referrer" srcDoc={frame} />
        ) : (
          <SourceLines text={loaded.result.text} first={loaded.result.startLine} />
        )}
      </div>
    </section>
  );
}

/** The text of a file, one numbered line after the other. */
function SourceLines({ text, first }: { text: string; first: number }) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  return (
    <pre className="file-source" tabIndex={0}>
      {lines.map((line, i) => (
        <span key={i} className="file-line">
          <span className="file-ln" aria-hidden>
            {first + i}
          </span>
          {line || " "}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
