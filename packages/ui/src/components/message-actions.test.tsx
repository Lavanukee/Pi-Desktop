import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageActions } from './message-actions.tsx';
import { TooltipProvider } from './tooltip.tsx';

/**
 * Under-message action bar — jedd Wave B. The bar is scaled ~1.5× (bigger touch
 * targets + glyphs, #1) and the response speed moved OFF the pinned footnote and
 * INTO the bar as its own item (#2). Asserted through the repo's jsdom-free
 * static-markup convention; the bar's Tooltips need a TooltipProvider ancestor.
 */
const noop = () => {};

function render(ui: ReactElement): string {
  return renderToStaticMarkup(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('MessageActions bar (Wave B)', () => {
  it('scales the action glyphs 1.5× — 14 → 21px, none left at the old size', () => {
    const html = render(<MessageActions onCopy={noop} onRetry={noop} onShare={noop} />);
    expect(html).toContain('pd-msg-action-bar');
    expect(html).toContain('width="21"');
    expect(html).toContain('height="21"');
    // No glyph is left at the pre-scale 14px size.
    expect(html).not.toContain('width="14"');
  });

  it('renders the response speed AS a bar item (default "~" prefix, rounded)', () => {
    const html = render(<MessageActions onCopy={noop} tokensPerSecond={37.6} />);
    expect(html).toContain('pd-msg-speed');
    expect(html).toContain('~38 tok/s');
    // It lives inside the bar row — NOT re-introduced as a pinned footnote.
    expect(html).not.toContain('pd-msg-footnote');
  });

  it('drops the "~" when approxSpeed is false', () => {
    const html = render(<MessageActions onCopy={noop} tokensPerSecond={180} approxSpeed={false} />);
    expect(html).toContain('pd-msg-speed');
    expect(html).toContain('180 tok/s');
    expect(html).not.toContain('~180');
  });

  it('omits the speed item entirely when tokensPerSecond is undefined', () => {
    const html = render(<MessageActions onCopy={noop} tokenCount={1240} />);
    expect(html).not.toContain('pd-msg-speed');
    expect(html).not.toContain('tok/s');
    // The token-count chip is unaffected.
    expect(html).toContain('pd-msg-context');
    expect(html).toContain('1.2k');
  });

  it('places speed and token-count side by side when both are set', () => {
    const html = render(<MessageActions onCopy={noop} tokensPerSecond={42} tokenCount={940} />);
    expect(html).toContain('~42 tok/s');
    expect(html).toContain('940');
    expect(html.indexOf('pd-msg-speed')).toBeLessThan(html.indexOf('pd-msg-context'));
  });
});
