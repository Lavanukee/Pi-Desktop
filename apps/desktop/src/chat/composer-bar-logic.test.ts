import { describe, expect, it } from 'vitest';
import {
  classificationHover,
  effortDisplay,
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

describe('effortDisplay', () => {
  it('maps the effort scale to display names, with the mid/auto default → "Balanced"', () => {
    expect(effortDisplay('low')).toBe('Low');
    expect(effortDisplay('medium')).toBe('Balanced');
    expect(effortDisplay('high')).toBe('High');
    expect(effortDisplay('max')).toBe('Max');
  });
});

describe('effortSliderView', () => {
  it('auto: the label reads the literal "Effort · Auto" while the tier still drives the slider position', () => {
    // fast → the knob rests at the low detent, but the readout says "Auto".
    expect(effortSliderView('auto', 'medium', 'fast')).toMatchObject({
      auto: true,
      index: 0,
      fill: 0,
      label: 'Effort · Auto',
      valueText: 'Effort, Auto',
    });

    // balanced → the knob sits at the mid detent; the label stays "Effort · Auto".
    const bal = effortSliderView('auto', 'low', 'balanced');
    expect(bal.auto).toBe(true);
    expect(bal.label).toBe('Effort · Auto');
    expect(bal.valueText).toBe('Effort, Auto');
    expect(bal.index).toBe(1); // medium — the routed position, not the readout
    expect(bal.fill).toBeCloseTo(1 / 3, 5);

    // intelligent → the knob rests at the tick below max; still "Effort · Auto".
    const smart = effortSliderView('auto', 'low', 'intelligent');
    expect(smart.label).toBe('Effort · Auto');
    expect(smart.valueText).toBe('Effort, Auto');
    expect(smart.index).toBe(2);
    expect(smart.fill).toBeCloseTo(2 / 3, 5);
  });

  it('auto + no tier yet: still reads "Effort · Auto", resting the knob on the explicit level', () => {
    expect(effortSliderView('auto', 'high', null)).toMatchObject({
      auto: true,
      label: 'Effort · Auto',
      valueText: 'Effort, Auto',
      index: 2, // the knob rests on the last explicit level
    });
    // Regardless of the resting level, the auto readout is the word "Auto".
    expect(effortSliderView('auto', 'medium', null).label).toBe('Effort · Auto');
  });

  it('level mode: pins the explicit level (max reachable), ignoring the tier', () => {
    expect(effortSliderView('level', 'max', 'fast')).toMatchObject({
      auto: false,
      index: 3,
      fill: 1,
      label: 'Effort · Max',
    });
    expect(effortSliderView('level', 'low', 'intelligent')).toMatchObject({
      auto: false,
      index: 0,
      fill: 0,
      label: 'Effort · Low',
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
