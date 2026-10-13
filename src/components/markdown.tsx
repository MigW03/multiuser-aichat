import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Raw HTML in the source is not rendered (react-markdown escapes it), so model output can't inject markup.
const components: Components = {
  p: (props) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
  h1: (props) => <h1 className="mb-2 mt-4 text-xl font-semibold first:mt-0" {...props} />,
  h2: (props) => <h2 className="mb-2 mt-4 text-lg font-semibold first:mt-0" {...props} />,
  h3: (props) => <h3 className="mb-1 mt-3 font-semibold first:mt-0" {...props} />,
  h4: (props) => <h4 className="mb-1 mt-3 font-semibold first:mt-0" {...props} />,
  ul: (props) => <ul className="my-2 list-disc pl-5" {...props} />,
  ol: (props) => <ol className="my-2 list-decimal pl-5" {...props} />,
  li: (props) => <li className="my-0.5" {...props} />,
  a: (props) => <a className="underline" target="_blank" rel="noopener noreferrer" {...props} />,
  blockquote: (props) => (
    <blockquote className="my-2 border-l-2 border-neutral-400 pl-3 text-neutral-600 dark:text-neutral-400" {...props} />
  ),
  hr: () => <hr className="my-3 border-neutral-300 dark:border-neutral-700" />,
  pre: (props) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-neutral-200 p-3 text-sm dark:bg-neutral-800" {...props} />
  ),
  code: ({ className, ...props }) =>
    // Fenced blocks get a language-* class; inline code does not.
    className ? (
      <code className={`${className} font-mono`} {...props} />
    ) : (
      <code className="rounded bg-neutral-200 px-1 py-0.5 font-mono text-[0.9em] dark:bg-neutral-800" {...props} />
    ),
  table: (props) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-sm" {...props} />
    </div>
  ),
  th: (props) => <th className="border border-neutral-300 px-2 py-1 text-left dark:border-neutral-700" {...props} />,
  td: (props) => <td className="border border-neutral-300 px-2 py-1 dark:border-neutral-700" {...props} />,
};

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}
