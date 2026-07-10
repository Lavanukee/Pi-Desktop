import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EffortSlider, pointerToIndex } from './effort-slider.tsx';

/**
 * EffortSlider (round-12 #6): the pointer-drag math is pure + tested directly;
 * the presentational contract (blue fill width, Auto affordance vs level
 * readout, slider aria) is asserted through static markup so no DOM is needed.
 */
describe('pointerToIndex', () => {
  it('maps a 0..1 track fraction to the nearest of `steps` detents', () => {
    expect(pointerToIndex(0, 4)).toBe(0);
    expect(pointerToIndex(1, 4)).toBe(3);
    expect(pointerToIndex(0.5, 4)).toBe(2); // 1.5 → 2
    expect(pointerToIndex(0.33, 4)).toBe(1); // 0.99 → 1
    expect(pointerToIndex(0.66, 4)).toBe(2); // 1.98 → 2
  });

  it('clamps out-of-range + degenerate inputs to the ends / 0', () => {
    expect(pointerToIndex(-1, 4)).toBe(0);
    expect(pointerToIndex(2, 4)).toBe(3);
    expect(pointerToIndex(Number.NaN, 4)).toBe(0);
    expect(pointerToIndex(0.5, 1)).toBe(0);
    expect(pointerToIndex(0.5, 0)).toBe(0);
  });
});

describe('EffortSlider render', () => {
  it('auto mode: the Auto affordance carries the readout + is active; the blue fill follows the tier', () => {
    const html = renderToStaticMarkup(
      <EffortSlider
        steps={4}
        value={1}
        fill={1 / 3}
        auto
        label="Auto · balanced"
        valueText="Auto, balanced"
        onLevelChange={() => {}}
        onAuto={() => {}}
        data-testid="fx"
      />,
    );
    expect(html).toContain('Auto · balanced');
    expect(html).toContain('data-active=""'); // the Auto affordance is active
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuemax="3"');
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain('width:33'); // fill ≈ 33%
    expect(html).not.toContain('pd-effort-value'); // no explicit level readout in auto
  });

  it('level mode: shows the level readout, an inactive Auto reset, and the explicit fill', () => {
    const html = renderToStaticMarkup(
      <EffortSlider
        steps={4}
        value={3}
        fill={1}
        auto={false}
        label="Max"
        onLevelChange={() => {}}
        onAuto={() => {}}
      />,
    );
    expect(html).toContain('pd-effort-value');
    expect(html).toContain('Max');
    expect(html).toContain('>Auto<'); // the reset affordance (autoLabel default)
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('data-active');
    expect(html).toContain('aria-valuenow="3"');
    expect(html).toContain('width:100%');
  });
});
