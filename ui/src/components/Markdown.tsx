import { useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// AI output is untrusted. Raw HTML in the text is shown as text (no rehype-raw), unsafe link schemes are dropped
// by defaultUrlTransform, links open outside the app, and remote images are shown as links instead of loaded.
const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {alt || src}
      </a>
    ) : null,
  // A diff block shows added and removed lines in green and red, like the composer does while typing.
  code: ({ className, children }) => {
    const lang = /language-(\w+)/.exec(className ?? "")?.[1];
    if ((lang === "diff" || lang === "patch") && typeof children === "string") {
      return (
        <code className={className}>
          {children
            .replace(/\n$/, "")
            .split("\n")
            .map((line, i) => (
              <span key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "diff-add" : line.startsWith("-") && !line.startsWith("---") ? "diff-del" : "diff-line"}>
                {line || " "}
                {"\n"}
              </span>
            ))}
        </code>
      );
    }
    return <code className={className}>{children}</code>;
  },
};

function urlTransform(url: string) {
  const safe = defaultUrlTransform(url);
  return /^(https?:|mailto:|#)/i.test(safe) ? safe : "";
}

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

type Props = { text: string } & ({ chat?: undefined; mentions?: undefined } | { chat: true; mentions: string[] });

/** `chat` is for a message a person wrote; `mentions` are the names of the people they tagged. */
export function Markdown({ text, chat, mentions }: Props) {
  const key = chat ? mentions.join("\u0000") : "";
  const plugins = useMemo(() => (chat ? [remarkGfm, chatText(key ? key.split("\u0000") : [])] : [remarkGfm]), [chat, key]);
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
