import { CodeBlock, Prose } from '@pi-desktop/ui';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SurfaceProps } from '../registry.ts';

/**
 * Markdown surface — renders GitHub-flavored markdown into the shared Prose look
 * with fenced code delegated to the shared CodeBlock. react-markdown escapes raw
 * embedded HTML by default (no `rehype-raw`), so untrusted markdown cannot inject
 * script — the trust boundary here is "no raw HTML passthrough". Streaming-safe:
 * the full source is re-parsed on each delta (React reconciles the output).
 */
const components: Components = {
  // Unwrap the <pre> so the block CodeBlock (which renders its own <pre>) is not
  // nested inside one; inline code falls through to the `code` handler below.
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children }) {
    const match = /language-(\w+)/.exec(className ?? '');
    if (match) {
      const text = String(children).replace(/\n$/, '');
      return <CodeBlock code={text} language={match[1]} />;
    }
    return <code className={className}>{children}</code>;
  },
};

export function MarkdownSurface({ content }: SurfaceProps) {
  return (
    <div className="pd-canvas-markdown pd-scroll">
      <Prose>
        <Markdown remarkPlugins={[remarkGfm]} components={components}>
          {content.text}
        </Markdown>
      </Prose>
    </div>
  );
}
