import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

const mdComponents = {
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="text-(--color-accent) underline underline-offset-2 hover:opacity-80"
    />
  ),
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props} className="my-2 first:mt-0 last:mb-0 leading-relaxed" />
  ),
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
    <ul {...props} className="my-2 pl-5 list-disc space-y-1" />
  ),
  ol: (props: React.OlHTMLAttributes<HTMLOListElement>) => (
    <ol {...props} className="my-2 pl-5 list-decimal space-y-1" />
  ),
  li: (props: React.LiHTMLAttributes<HTMLLIElement>) => (
    <li {...props} className="leading-relaxed" />
  ),
  h1: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1 {...props} className="text-base font-semibold mt-3 mb-2 first:mt-0" />
  ),
  h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...props} className="text-sm font-semibold mt-3 mb-2 first:mt-0" />
  ),
  h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 {...props} className="text-sm font-semibold mt-2 mb-1 first:mt-0" />
  ),
  code: ({ className, children, ...rest }: React.HTMLAttributes<HTMLElement>) => {
    const isBlock = /language-/.test(className ?? '');
    return isBlock ? (
      <code {...rest} className={`${className ?? ''} block`}>
        {children}
      </code>
    ) : (
      <code
        {...rest}
        className="px-1 py-0.5 rounded bg-(--color-surface) text-(--color-fg) text-[0.85em] font-mono"
      >
        {children}
      </code>
    );
  },
  pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
    <pre
      {...props}
      className="my-2 p-2 rounded bg-(--color-surface) text-xs font-mono overflow-x-auto"
    />
  ),
  blockquote: (props: React.HTMLAttributes<HTMLQuoteElement>) => (
    <blockquote
      {...props}
      className="my-2 pl-3 border-l-2 border-(--color-border) text-(--color-muted)"
    />
  ),
  table: (props: React.HTMLAttributes<HTMLTableElement>) => (
    <div className="my-2 overflow-x-auto">
      <table {...props} className="text-xs border-collapse" />
    </div>
  ),
  th: (props: React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th
      {...props}
      className="px-2 py-1 border border-(--color-border) bg-(--color-surface) font-semibold text-left"
    />
  ),
  td: (props: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td {...props} className="px-2 py-1 border border-(--color-border) align-top" />
  ),
  img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...props}
      alt={props.alt ?? ''}
      className="my-2 max-w-full h-auto rounded border border-(--color-border)"
    />
  ),
  hr: (props: React.HTMLAttributes<HTMLHRElement>) => (
    <hr {...props} className="my-3 border-(--color-border)" />
  ),
};

export function MarkdownView({ source }: { source: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={mdComponents}
    >
      {source}
    </ReactMarkdown>
  );
}
