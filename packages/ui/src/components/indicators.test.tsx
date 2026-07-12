import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkingIndicator } from './indicators.tsx';

/**
 * Streaming "working" indicator — jedd Wave B #3. The status label must stay
 * LEGIBLE while its tint animates: the glyphs are real painted text (a solid
 * floor color) with a highlight band sweeping over them, never a text-clip mask
 * that erases the letters. The jsdom-free static-markup convention can't observe
 * the CSS sweep, but it CAN pin the contract that matters here: the label text
 * is present as actual glyphs in the DOM, on the legibility-preserving
 * .pd-working-label element (whose floor layer keeps it readable).
 */
describe('WorkingIndicator (Wave B #3)', () => {
  it('paints the label as real text on the legible working-label element', () => {
    const html = renderToStaticMarkup(<WorkingIndicator label="Working" elapsedSeconds={20} />);
    expect(html).toContain('pd-working');
    expect(html).toContain('pd-working-label');
    // The letters are actual DOM text — the fix keeps them painted, not clipped.
    expect(html).toContain('>Working<');
    // The branded caret loader rides inside the indicator.
    expect(html).toContain('pd-loader');
  });

  it('renders the elapsed counter as "· Ns" when provided', () => {
    const html = renderToStaticMarkup(<WorkingIndicator label="Working" elapsedSeconds={20} />);
    expect(html).toContain('pd-working-elapsed');
    expect(html).toContain('· 20s');
  });

  it('omits the elapsed counter when elapsedSeconds is undefined', () => {
    const html = renderToStaticMarkup(<WorkingIndicator label="Thinking" />);
    expect(html).toContain('>Thinking<');
    expect(html).not.toContain('pd-working-elapsed');
  });

  it('keeps the retry phrase legible in the label', () => {
    const html = renderToStaticMarkup(
      <WorkingIndicator label="Retrying (2/3)…" elapsedSeconds={12} />,
    );
    expect(html).toContain('Retrying (2/3)…');
    expect(html).toContain('· 12s');
  });

  it('merges a custom className onto the indicator root', () => {
    const html = renderToStaticMarkup(<WorkingIndicator label="Working" className="py-2" />);
    expect(html).toContain('pd-working');
    expect(html).toContain('py-2');
  });
});
