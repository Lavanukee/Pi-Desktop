import { describe, expect, it } from 'vitest';
import { TASK_CLASSES, type TaskClass } from './classify.js';
import {
  COARSE_TO_MODEL,
  type CoarseTier,
  coarseTier,
  isCoarseTier,
  isModelTier,
  MODEL_TIERS,
  type ModelTier,
  modelTierForClass,
  TIER_LABEL,
} from './tier.js';

describe('coarseTier', () => {
  const cases: Record<TaskClass, CoarseTier> = {
    'simple-QA': 'quick',
    'basic-tools': 'balanced',
    other: 'balanced',
    connectors: 'balanced',
    'file-ops': 'balanced',
    '2d-art': 'balanced',
    'video-edit': 'balanced',
    perception: 'balanced',
    coding: 'complex',
    'browser-use': 'complex',
    '3d': 'complex',
    'motion-graphics': 'complex',
    'advanced-video': 'complex',
  };

  it('maps every TaskClass to its coarse tier', () => {
    for (const cls of TASK_CLASSES) {
      expect(coarseTier(cls)).toBe(cases[cls]);
    }
  });

  it('covers all task classes (exhaustive, no undefined)', () => {
    for (const cls of TASK_CLASSES) {
      expect(isCoarseTier(coarseTier(cls))).toBe(true);
    }
  });
});

describe('modelTierForClass', () => {
  const expected: Record<TaskClass, ModelTier> = {
    'simple-QA': 'fast',
    'basic-tools': 'balanced',
    other: 'balanced',
    connectors: 'balanced',
    'file-ops': 'balanced',
    '2d-art': 'balanced',
    'video-edit': 'balanced',
    perception: 'balanced',
    coding: 'intelligent',
    'browser-use': 'intelligent',
    '3d': 'intelligent',
    'motion-graphics': 'intelligent',
    'advanced-video': 'intelligent',
  };

  it('routes each class to the user-facing model tier via COARSE_TO_MODEL', () => {
    for (const cls of TASK_CLASSES) {
      expect(modelTierForClass(cls)).toBe(expected[cls]);
      expect(modelTierForClass(cls)).toBe(COARSE_TO_MODEL[coarseTier(cls)]);
    }
  });
});

describe('tier constants + guards', () => {
  it('has a label for every model tier', () => {
    for (const t of MODEL_TIERS) {
      expect(TIER_LABEL[t]).toBeTruthy();
    }
    expect(TIER_LABEL).toEqual({ fast: 'Fast', balanced: 'Balanced', intelligent: 'Intelligent' });
  });

  it('isModelTier accepts the three tiers and rejects junk', () => {
    for (const t of MODEL_TIERS) expect(isModelTier(t)).toBe(true);
    expect(isModelTier('quick')).toBe(false);
    expect(isModelTier('wizard')).toBe(false);
    expect(isModelTier(42)).toBe(false);
  });
});
