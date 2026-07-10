import { clsx } from 'clsx';
import type { ComponentPropsWithoutRef, HTMLAttributes, ReactNode } from 'react';
import { forwardRef, isValidElement } from 'react';
import ReactMarkdown, { type Components, type ExtraProps, type Options } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { CodeBlock } from './code-block.tsx';

/*
 * Reusable markdown renderer (round-3 #P4). react-markdown + remark-gfm +
 * remark-math + rehype-katex, rendered into a `.pd-prose` container so it reads
 * in the flavor's response voice. Custom renderers:
 *   - fenced code  -> CodeBlock (the sticky-copy panel)
 *   - inline code  -> a subtle rounded mono box; if the token IS a hex color
 *                     (`#0a84ff`) a small swatch chip is shown before it
 *   - tables       -> wrapped in the prose scroll container
 * Math degrades gracefully (rehype-katex throwOnError:false — bad LaTeX renders
 * as tinted source instead of crashing the tree).
 *
 * KaTeX offline handling (integration contract): the stylesheet is imported from
 * the package here (`katex/dist/katex.min.css`), so the app's bundler (Vite /
 * electron-vite) inlines it and rewrites the KaTeX font URLs to LOCAL bundled
 * assets — no runtime/external font fetch. Nothing else is required; because the
 * CSS is pulled through a JS import (not a file under src/styles/**), it does not
 * pass through the token styles-hygiene rule.
 */
import 'katex/dist/katex.min.css';

/** Flatten a React node tree to its text content. */
function toText(node: ReactNode): string {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toText).join('');
  if (isValidElement(node)) {
    return toText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

/** Return the normalized `#rgb|#rgba|#rrggbb|#rrggbbaa` if the text IS one hex color. */
function hexColor(text: string): string | null {
  const match = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(text.trim());
  return match ? `#${match[1]}` : null;
}

/** Fenced code block → the shared CodeBlock panel. */
function PreBlock({ children }: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  const codeEl = Array.isArray(children) ? children[0] : children;
  if (isValidElement(codeEl)) {
    const props = codeEl.props as { className?: string; children?: ReactNode };
    const language = /language-([\w-]+)/.exec(props.className ?? '')?.[1];
    const code = toText(props.children).replace(/\n$/, '');
    return <CodeBlock code={code} language={language} />;
  }
  return <pre className="pd-scroll">{children}</pre>;
}

/** Inline code chip; prefixes a color swatch when the token is a hex color. */
function InlineCode({ className, children }: ComponentPropsWithoutRef<'code'> & ExtraProps) {
  const hex = hexColor(toText(children));
  return (
    <code className={clsx('pd-md-code', className)}>
      {hex ? (
        <span className="pd-md-swatch" style={{ backgroundColor: hex }} aria-hidden="true" />
      ) : null}
      {children}
    </code>
  );
}

/** Tables break out of the prose column into their own scroll container. */
function TableBlock({ children }: ComponentPropsWithoutRef<'table'> & ExtraProps) {
  return (
    <div className="pd-prose-table-wrap">
      <table>{children}</table>
    </div>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  pre: PreBlock,
  code: InlineCode,
  table: TableBlock,
};

/** Minimal mdast shape the display-math promotion needs (avoids an @types/mdast dep). */
interface MathTreeNode {
  type: string;
  value?: string;
  children?: MathTreeNode[];
  position?: { start?: { offset?: number } };
  data?: { hProperties?: { className?: string[] } };
}

/**
 * remark plugin: promote a standalone `$$…$$` paragraph to DISPLAY math.
 * remark-math tokenizes `$$…$$` written on a single line as INLINE text-math
 * (only a fenced `$$`\n…\n`$$` block becomes flow/display), so single-line
 * block equations render left-aligned inline with no `.katex-display` wrapper —
 * the center+scroll rule in markdown.css then never applies. This walks the AST
 * (so fenced code is untouched) and, when a paragraph is exactly one inlineMath
 * whose source really starts with `$$` (a lone `$x$` stays inline), swaps its
 * hast class to `math-display` so rehype-katex renders it in display mode.
 */
function remarkDisplayMath() {
  return (tree: MathTreeNode, file: { value?: unknown }) => {
    const source = typeof file.value === 'string' ? file.value : '';
    const promote = (node: MathTreeNode): void => {
      const children = node.children;
      if (!children) return;
      if (node.type === 'paragraph') {
        const content = children.filter(
          (child) => !(child.type === 'text' && (child.value ?? '').trim() === ''),
        );
        const only = content[0];
        const offset = only?.position?.start?.offset;
        if (
          content.length === 1 &&
          only?.type === 'inlineMath' &&
          typeof offset === 'number' &&
          source.slice(offset, offset + 2) === '$$'
        ) {
          only.data = {
            ...only.data,
            hProperties: {
              ...only.data?.hProperties,
              className: ['language-math', 'math-display'],
            },
          };
        }
        return;
      }
      for (const child of children) promote(child);
    };
    promote(tree);
  };
}

const REMARK_PLUGINS: Options['remarkPlugins'] = [remarkGfm, remarkMath, remarkDisplayMath];
const REHYPE_PLUGINS: Options['rehypePlugins'] = [
  [rehypeKatex, { throwOnError: false, errorColor: 'currentColor' }],
];

export interface MarkdownProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** The markdown source to render (a plain string). */
  children: string;
}

/**
 * Render a markdown string into flavor-voiced prose. Drop-in for a text run:
 * pass the raw string as children; it renders its OWN `.pd-prose` container, so
 * hosts should not double-wrap it in `<Prose>`.
 */
export const Markdown = forwardRef<HTMLDivElement, MarkdownProps>(function Markdown(
  { children, className, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={clsx('pd-prose', 'pd-markdown', className)} {...rest}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
