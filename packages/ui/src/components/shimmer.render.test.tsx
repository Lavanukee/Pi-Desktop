import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ThinkingBlock } from './shimmer.tsx';

/**
 * ThinkingBlock markdown rendering (jedd round-8 #9): a string thought is piped
 * through the shared Markdown component, so thoughts get **bold**, code, lists
 * and $math$ (the same pipeline as responses) instead of plain text — while the
 * collapse pill / "Thought for X" label / Show-more chrome are unchanged.
 */
describe('ThinkingBlock markdown rendering', () => {
  const md = 'A **bold** word, `inline code`, a list:\n\n- one\n- two\n\nand $E = mc^2$.';

  it('renders string thought content through the Markdown component', () => {
    const html = renderToStaticMarkup(<ThinkingBlock defaultExpanded>{md}</ThinkingBlock>);
    // Rendered via the shared Markdown pipeline (its .pd-markdown / .pd-prose container).
    expect(html).toContain('pd-markdown');
    expect(html).toContain('pd-thinking-md');
    // Actual formatting applied — not plain text.
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code'); // inline code chip
    expect(html).toContain('<li>'); // list item
    expect(html).toContain('katex'); // KaTeX-rendered math
  });

  it('keeps the collapse pill and past-tense label around the markdown', () => {
    const html = renderToStaticMarkup(<ThinkingBlock durationMs={12000}>{md}</ThinkingBlock>);
    expect(html).toContain('pd-thinking-pill');
    expect(html).toContain('Thought for 12s');
    // Content stays mounted even while collapsed (CSS height-roll reveal).
    expect(html).toContain('pd-markdown');
  });

  it('renders non-string children as-is (no Markdown wrapper)', () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock defaultExpanded>
        <em>custom node</em>
      </ThinkingBlock>,
    );
    expect(html).toContain('<em>custom node</em>');
    expect(html).not.toContain('pd-markdown');
  });
});
