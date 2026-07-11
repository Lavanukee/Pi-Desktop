import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EffortSlider, pointerToIndex } from './effort-slider.tsx';

/**
 * EffortSlider (round-12 #6, restyled round-16): the pointer-drag math is pure +
 * tested directly; the presentational contract (the accent-lit header readout,
 * the "Faster"/"Smarter" flanks, the heat fill width, the Auto toggle state, and
 * the slider aria) is asserted through static markup so no DOM is needed.
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
  it('auto mode: the header carries the accent readout, the Auto toggle is active, the fill follows the tier', () => {
    const html = renderToStaticMarkup(
      <EffortSlider
        steps={4}
        value={1}
        fill={1 / 3}
        auto
        label="Effort · Auto"
        valueText="Effort, Auto"
        onLevelChange={() => {}}
        onAuto={() => {}}
        data-testid="fx"
      />,
    );
    expect(html).toContain('pd-effort-name'); // the accent-lit header readout
    expect(html).toContain('Effort · Auto'); // …carrying the label
    expect(html).toContain('Faster'); // the flank end labels
    expect(html).toContain('Smarter');
    expect(html).toContain('pd-effort-help'); // the "?" help affordance
    expect(html).toContain('data-active=""'); // the Auto toggle is lit
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuemax="3"');
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain('width:33'); // fill ≈ 33% (the routed position)
  });

  it('level mode: the header shows the pinned level, the Auto toggle is an inactive reset, the fill is explicit', () => {
    const html = renderToStaticMarkup(
      <EffortSlider
        steps={4}
        value={3}
        fill={1}
        auto={false}
        label="Effort · Max"
        onLevelChange={() => {}}
        onAuto={() => {}}
      />,
    );
    expect(html).toContain('pd-effort-name');
    expect(html).toContain('Effort · Max'); // the pinned level readout
    expect(html).toContain('>Auto<'); // the reset toggle (autoLabel default)
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('data-active'); // the toggle is not lit
    expect(html).toContain('aria-valuenow="3"');
    expect(html).toContain('width:100%');
  });
});
