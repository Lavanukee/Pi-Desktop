import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS, effortKnobs, isEffortLevel } from './effort.js';

describe('effortKnobs', () => {
  it('has knobs for every level', () => {
    for (const level of EFFORT_LEVELS) {
      expect(effortKnobs(level).level).toBe(level);
    }
  });

  it('monotonically increases reliability knobs with effort', () => {
    const order = EFFORT_LEVELS.map(effortKnobs);
    for (let i = 1; i < order.length; i++) {
      const prev = order[i - 1];
      const cur = order[i];
      expect(cur).toBeDefined();
      expect(prev).toBeDefined();
      if (prev === undefined || cur === undefined) continue;
      expect(cur.repairAttempts).toBeGreaterThanOrEqual(prev.repairAttempts);
      expect(cur.abortThreshold).toBeGreaterThanOrEqual(prev.abortThreshold);
      expect(cur.reviewPasses).toBeGreaterThanOrEqual(prev.reviewPasses);
      expect(cur.imageRefinePasses).toBeGreaterThanOrEqual(prev.imageRefinePasses);
    }
  });

  it('enables adversarial checks only at high and max', () => {
    expect(effortKnobs('low').adversarialChecks).toBe(false);
    expect(effortKnobs('medium').adversarialChecks).toBe(false);
    expect(effortKnobs('high').adversarialChecks).toBe(true);
    expect(effortKnobs('max').adversarialChecks).toBe(true);
  });

  it('isEffortLevel guards unknown strings', () => {
    expect(isEffortLevel('high')).toBe(true);
    expect(isEffortLevel('turbo')).toBe(false);
  });
});
