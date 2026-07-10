import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '../test-utils.tsx';
import { SvgSurface } from './svg-surface.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SvgSurface', () => {
  it('sanitizes and injects the SVG on the final (non-streaming) render', async () => {
    const { container } = await render(
      <SvgSurface
        content={{
          kind: 'svg',
          text: '<svg><script>evil()</script><circle cx="5" cy="5" r="4"></circle></svg>',
        }}
        streaming={false}
      />,
    );
    const host = container.querySelector('.pd-canvas-svg');
    expect(host?.querySelector('circle')).toBeTruthy();
    expect(host?.querySelector('script')).toBeNull();
    expect(host?.innerHTML.toLowerCase()).not.toContain('evil');
  });

  it('renders incomplete SVG progressively while streaming (rAF-coalesced)', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const { container } = await render(
      <SvgSurface
        content={{ kind: 'svg', text: '<svg viewBox="0 0 10 10"><path d="M0 0 L5 5"></path>' }}
        streaming={true}
      />,
    );
    const host = container.querySelector('.pd-canvas-svg');
    expect(host?.querySelector('path')).toBeTruthy();
  });
});
