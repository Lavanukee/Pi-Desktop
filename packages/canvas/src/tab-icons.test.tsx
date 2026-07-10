import { describe, expect, it } from 'vitest';
import { IconAppGeneric, IconPopout } from './tab-icons.tsx';
import { render } from './test-utils.tsx';

describe('tab-icons', () => {
  it('IconPopout renders a clean box + arrow (well-formed path data, round-8 img62)', async () => {
    const { container } = await render(<IconPopout />);
    const svg = container.querySelector('svg.pd-icon');
    expect(svg).toBeTruthy();
    const paths = [...container.querySelectorAll('path')];
    // A window box + the arrow head + its shaft.
    expect(paths.length).toBeGreaterThanOrEqual(2);
    for (const p of paths) {
      const d = p.getAttribute('d') ?? '';
      expect(d.length).toBeGreaterThan(0);
      // No malformed coordinates from undefined interpolation.
      expect(d).not.toMatch(/NaN|undefined/);
    }
  });

  it('IconAppGeneric renders four app tiles as the generic fallback', async () => {
    const { container } = await render(<IconAppGeneric />);
    expect(container.querySelectorAll('rect')).toHaveLength(4);
  });
});
