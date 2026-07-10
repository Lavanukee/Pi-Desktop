import { clsx } from 'clsx';
import type { HTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { useCopyFeedback } from './copy-button.tsx';
import { IconCheck, IconCopy } from './icons.tsx';

export type ProseProps = HTMLAttributes<HTMLDivElement>;

/**
 * Prose container — spec-markdown.md. Voice/width from response tokens;
 * flavor rhythm lives in prose.css. W3 renders markdown into it.
 */
export const Prose = forwardRef<HTMLDivElement, ProseProps>(function Prose(
  { className, ...rest },
  ref,
) {
  return <div ref={ref} className={clsx('pd-prose', className)} {...rest} />;
});

export interface CodeBlockProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onCopy'> {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  onCopy?: (code: string) => void;
}

/**
 * Code block — spec-markdown.md. Claude's zero-width sticky copy rail adopted
 * for both flavors; panel chrome on --pd-code-block-* tokens; line numbers are
 * copy-safe (attr() pseudo-content). Syntax highlighting is W3's concern
 * (shiki css-vars per spec) — pass pre-highlighted children instead of `code`
 * when available.
 */
export const CodeBlock = forwardRef<HTMLDivElement, CodeBlockProps>(function CodeBlock(
  { code, language, showLineNumbers = false, onCopy, className, children, ...rest },
  ref,
) {
  const { copied, copy } = useCopyFeedback({ onCopy });
  const handleCopy = () => copy(code);

  const lines = code.split('\n');

  return (
    <div ref={ref} className={clsx('pd-code-block', className)} {...rest}>
      <div className="pd-code-block-rail">
        <button
          type="button"
          className="pd-btn pd-btn--ghost pd-icon-btn pd-btn--sm pd-code-block-copy"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={handleCopy}
        >
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        </button>
      </div>
      {language !== undefined ? <div className="pd-code-block-lang">{language}</div> : null}
      <pre className="pd-scroll">
        <code>
          {children ??
            (showLineNumbers
              ? lines.map((line, index) => {
                  const lineNumber = index + 1;
                  return (
                    <span key={lineNumber} className="pd-code-line" data-line-number={lineNumber}>
                      {line}
                      {'\n'}
                    </span>
                  );
                })
              : code)}
        </code>
      </pre>
    </div>
  );
});
