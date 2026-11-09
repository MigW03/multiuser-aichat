import { parsePreviewUrl } from "@mc/shared";
import { Check, Copy } from "lucide-react";
import { Children, createContext, isValidElement, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AppContext } from "../data.tsx";
import { codeLines, showLineNumbers } from "../lib/codeLines.ts";
import { looksLikeFilePath, resolveRelative } from "../lib/fileKind.ts";
import { ICON_SM, STROKE } from "./kit.tsx";

// AI output is untrusted. Raw HTML in the text is shown as text (no rehype-raw), unsafe link schemes are dropped
// by defaultUrlTransform, links open outside the app, and remote images are shown as links instead of loaded.
// A localhost address written out as the link text opens in the app's preview (desktop app). A link that only says something
// else ("click here") never does: what it points to is shown under the message instead, where the address can be read.
// Inside a file shown in the file panel, a link to another file (relative) opens that file. `dir` is the folder the file is in.
const FileLinks = createContext<{ dir: string } | null>(null);

function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const preview = useContext(AppContext)?.preview;
  const files = useContext(AppContext)?.files;
  const inFile = useContext(FileLinks);
  if (!href) return <span>{children}</span>;
  if (inFile && !/^(https?:|mailto:|#)/i.test(href)) {
    const target = resolveRelative(inFile.dir, href);
    if (!target || !files) return <span>{children}</span>;
    // No href: a relative address is never something the browser itself should follow.
    return (
      <button type="button" className="file-link" title={target} onClick={() => files.open(target)}>
        {children}
      </button>
    );
  }
  const local = preview?.available && typeof children === "string" && children === href ? parsePreviewUrl(href) : null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      {...(local ? { title: "Show in the preview", onClick: (e: { preventDefault: () => void }) => (e.preventDefault(), preview?.show(local)) } : {})}
    >
      {children}
    </a>
  );
}

/** A fenced block: language and a Copy button on top, line numbers past a few lines, added and removed lines of a diff in green and red. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find(isValidElement) as { props: { className?: string; children?: ReactNode } } | undefined;
  const raw = code?.props.children;
  const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.filter((x) => typeof x === "string").join("") : "";
  const lang = /language-([\w+-]+)/.exec(code?.props.className ?? "")?.[1];
  const lines = useMemo(() => codeLines(text, lang), [text, lang]);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard?.writeText(lines.map((l) => l.text).join("\n")).then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <div className={`code-block ${showLineNumbers(lines.length) ? "numbered" : ""}`}>
      <div className="code-head">
        <span className="code-lang">{lang ?? "text"}</span>
        <button type="button" className="code-copy" onClick={copy} aria-label="Copy code">
          {copied ? <Check size={ICON_SM} strokeWidth={STROKE} aria-hidden /> : <Copy size={ICON_SM} strokeWidth={STROKE} aria-hidden />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code className={code?.props.className}>
          {lines.map((l, i) => (
            <span key={i} className={`cl ${l.kind === "add" ? "diff-add" : l.kind === "del" ? "diff-del" : ""}`}>
              {l.text || " "}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

const components: Components = {
  a: Link,
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {alt || src}
      </a>
    ) : null,
  code: ({ className, children }) => {
    return <FileCode className={className}>{children}</FileCode>;
  },
  pre: CodeBlock,
};

/**
 * `code` in the text. When the project shares files and it reads like the path of one (`README.md`, `src/index.html`), a click
 * opens that file in the file panel; if no shared folder has it, the panel says so.
 */
function FileCode({ className, children }: { className?: string; children?: ReactNode }) {
  const files = useContext(AppContext)?.files;
  const text = typeof children === "string" ? children : null;
  if (!files?.hasAny || className || text === null || text.includes("\n") || !looksLikeFilePath(text)) return <code className={className}>{children}</code>;
  return (
    <button type="button" className="file-code" title={`Open ${text}`} onClick={() => files.open(text, true)}>
      <code>{children}</code>
    </button>
  );
}

// A link to another file is a relative path; the file panel turns it into an open call (see Link), so it passes here untouched.
const SAFE_URL = /^(https?:|mailto:|#)/i;
const RELATIVE_FILE = /^(?![a-z][a-z0-9+.-]*:|\/\/)[^\s]+$/i;
const urlTransform = (url: string) => {
  const safe = defaultUrlTransform(url);
  return SAFE_URL.test(safe) ? safe : "";
};
const fileUrlTransform = (url: string) => (RELATIVE_FILE.test(url) ? url : urlTransform(url));

type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown> };

/**
 * For messages people write: a line break in the text stays a line break, and "@Name" of each tagged person is
 * highlighted. Code is left alone.
 */
function chatText(names: string[]) {
  const escaped = [...names].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const tag = escaped.length ? new RegExp(`(@(?:${escaped.join("|")}))(?![\\p{L}\\p{N}_])`, "u") : null;
  const mention = (value: string): Node[] =>
    (tag ? value.split(tag) : [value]).flatMap((part, i): Node[] =>
      part === "" ? [] : i % 2 === 1 ? [{ type: "mention", data: { hName: "span", hProperties: { className: ["mention"] } }, children: [{ type: "text", value: part }] }] : [{ type: "text", value: part }],
    );
  const split = (value: string): Node[] => value.split("\n").flatMap((piece, i): Node[] => [...(i > 0 ? [{ type: "break" }] : []), ...mention(piece)]);
  const walk = (node: Node) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text" && child.value !== undefined) return split(child.value);
      walk(child);
      return [child];
    });
  };
  return () => (tree: unknown) => walk(tree as Node);
}

type Props = { text: string; /** The folder of the file being shown (file panel): links to other files in it open them. */ fileDir?: string } & ({ chat?: undefined; mentions?: undefined } | { chat: true; mentions: string[] });

/** `chat` is for a message a person wrote; `mentions` are the names of the people they tagged. */
export function Markdown({ text, chat, mentions, fileDir }: Props) {
  const key = chat ? mentions.join("\u0000") : "";
  const plugins = useMemo(() => (chat ? [remarkGfm, chatText(key ? key.split("\u0000") : [])] : [remarkGfm]), [chat, key]);
  const links = useMemo(() => (fileDir === undefined ? null : { dir: fileDir }), [fileDir]);
  return (
    <FileLinks.Provider value={links}>
      <div className="markdown">
        <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={links ? fileUrlTransform : urlTransform}>
          {text}
        </ReactMarkdown>
      </div>
    </FileLinks.Provider>
  );
}
