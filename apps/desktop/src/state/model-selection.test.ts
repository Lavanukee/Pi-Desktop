import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ADVANCED,
  type DesktopSettings,
} from '../../electron/settings/settings-contract';
import {
  autoEffortForTier,
  EFFORT_STEPS,
  isPinnedSelection,
  levelToSlider,
  resolveEffort,
  selectionTier,
  sliderToLevel,
} from './model-selection';

const base: DesktopSettings = {
  version: 1,
  theme: { flavor: 'claude', mode: 'system' },
  permissionMode: 'reviewer',
  effort: 'medium',
  userMode: 'user',
  enginePreference: 'llamacpp',
  modelSelection: { mode: 'auto' },
  effortMode: 'auto',
  search: { brave: '', tavily: '' },
  mcpMode: 'lite',
  capabilities: { image: false, video: false, audio: false, threeD: false },
  customInstructions: '',
  iconStroke: 1.25,
  sidebarScale: 1.0,
  menuScale: 1.0,
  favoriteModels: [],
  modelEffortDefaults: {},
  hfToken: '',
  experimentalProductionHarness: false,
  experimentalGeneration: false,
  advanced: DEFAULT_ADVANCED,
};

describe('autoEffortForTier', () => {
  it('maps fast→low, balanced→medium, intelligent→high (max never auto)', () => {
    expect(autoEffortForTier('fast')).toBe('low');
    expect(autoEffortForTier('balanced')).toBe('medium');
    expect(autoEffortForTier('intelligent')).toBe('high');
  });
});

describe('sliderToLevel / levelToSlider', () => {
  it('snaps 0..1 to the nearest detent', () => {
    expect(sliderToLevel(0)).toBe('low');
    expect(sliderToLevel(0.33)).toBe('medium');
    expect(sliderToLevel(0.66)).toBe('high');
    expect(sliderToLevel(1)).toBe('max');
    // clamps out-of-range
    expect(sliderToLevel(-1)).toBe('low');
    expect(sliderToLevel(2)).toBe('max');
    expect(sliderToLevel(Number.NaN)).toBe('low');
  });

  it('round-trips every level through levelToSlider → sliderToLevel', () => {
    for (const level of EFFORT_STEPS) {
      expect(sliderToLevel(levelToSlider(level))).toBe(level);
    }
    expect(levelToSlider('low')).toBe(0);
    expect(levelToSlider('max')).toBe(1);
  });
});

describe('resolveEffort', () => {
  it('auto mode derives from the active tier', () => {
    expect(resolveEffort({ ...base, effortMode: 'auto' }, 'fast')).toBe('low');
    expect(resolveEffort({ ...base, effortMode: 'auto' }, 'intelligent')).toBe('high');
  });

  it('auto mode with no active tier falls back to the explicit level', () => {
    expect(resolveEffort({ ...base, effortMode: 'auto', effort: 'high' }, null)).toBe('high');
  });

  it('level mode always uses the explicit level, ignoring the tier', () => {
    expect(resolveEffort({ ...base, effortMode: 'level', effort: 'max' }, 'fast')).toBe('max');
  });
});

describe('selection helpers', () => {
  it('isPinnedSelection is false for auto, true for tier/model', () => {
    expect(isPinnedSelection({ mode: 'auto' })).toBe(false);
    expect(isPinnedSelection({ mode: 'tier', tier: 'balanced' })).toBe(true);
    expect(isPinnedSelection({ mode: 'model', modelId: 'gemma-4-e2b-it' })).toBe(true);
  });

  it('selectionTier returns the pinned tier or null', () => {
    expect(selectionTier({ mode: 'tier', tier: 'intelligent' })).toBe('intelligent');
    expect(selectionTier({ mode: 'auto' })).toBeNull();
    expect(selectionTier({ mode: 'model', modelId: 'x' })).toBeNull();
  });
});
