import { describe, expect, it } from 'vitest';
import {
  classificationHover,
  effortSliderView,
  levelForIndex,
  tierLabel,
} from './composer-bar-logic';

/**
 * The composer-bar display logic (round-12 W2): the CENTER tier label + its
 * classification hover, and the RIGHT effort-slider view (Auto ↔ tier ↔ level).
 * ComposerBar.tsx renders these; the desktop test env is node, so the mapping
 * is tested here (no DOM).
 */
describe('tierLabel', () => {
  it('maps the active tier to its user-facing label; null before classify', () => {
    expect(tierLabel('fast')).toBe('Fast');
    expect(tierLabel('balanced')).toBe('Balanced');
    expect(tierLabel('intelligent')).toBe('Intelligent');
    expect(tierLabel(null)).toBeNull();
  });
});

describe('classificationHover', () => {
  it('builds "request categorized as <class>" (dashes → spaces)', () => {
    expect(classificationHover('basic-tools')).toBe('request categorized as basic tools');
    expect(classificationHover('coding')).toBe('request categorized as coding');
    expect(classificationHover('simple-QA')).toBe('request categorized as simple QA');
  });

  it('is null with no class', () => {
    expect(classificationHover(null)).toBeNull();
    expect(classificationHover(undefined)).toBeNull();
  });
});

describe('effortSliderView', () => {
  it('auto + tier: reads "Auto · <effort-level>" (NOT the tier name) and fills to the tier auto level', () => {
    // fast → low effort → "Auto · Low"
    expect(effortSliderView('auto', 'medium', 'fast')).toMatchObject({
      auto: true,
      index: 0,
      fill: 0,
      label: 'Auto · Low',
      valueText: 'Auto, low',
    });

    // balanced → medium effort → "Auto · Medium"
    const bal = effortSliderView('auto', 'low', 'balanced');
    expect(bal.auto).toBe(true);
    expect(bal.label).toBe('Auto · Medium');
    expect(bal.valueText).toBe('Auto, medium');
    expect(bal.index).toBe(1); // medium
    expect(bal.fill).toBeCloseTo(1 / 3, 5);

    // intelligent → high effort → "Auto · High" (the tick below max, never max)
    const smart = effortSliderView('auto', 'low', 'intelligent');
    expect(smart.label).toBe('Auto · High');
    expect(smart.valueText).toBe('Auto, high');
    expect(smart.index).toBe(2);
    expect(smart.fill).toBeCloseTo(2 / 3, 5);
  });

  it('auto + no tier yet: plain "Auto", resting on the explicit level', () => {
    expect(effortSliderView('auto', 'high', null)).toMatchObject({
      auto: true,
      label: 'Auto',
      valueText: 'Auto',
      index: 2,
    });
  });

  it('level mode: pins the explicit level (max reachable), ignoring the tier', () => {
    expect(effortSliderView('level', 'max', 'fast')).toMatchObject({
      auto: false,
      index: 3,
      fill: 1,
      label: 'Max',
    });
    expect(effortSliderView('level', 'low', 'intelligent')).toMatchObject({
      auto: false,
      index: 0,
      fill: 0,
      label: 'Low',
    });
  });
});

describe('levelForIndex', () => {
  it('maps a detent index back to its effort level (clamped)', () => {
    expect(levelForIndex(0)).toBe('low');
    expect(levelForIndex(1)).toBe('medium');
    expect(levelForIndex(2)).toBe('high');
    expect(levelForIndex(3)).toBe('max');
    expect(levelForIndex(-1)).toBe('low');
    expect(levelForIndex(9)).toBe('max');
  });
});
