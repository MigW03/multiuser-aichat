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
};

function urlTransform(url: string) {
  const safe = defaultUrlTransform(url);
  return /^(https?:|mailto:|#)/i.test(safe) ? safe : "";
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
