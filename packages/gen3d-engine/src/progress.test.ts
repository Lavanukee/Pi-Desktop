import { describe, expect, it } from 'vitest';
import { mapJobEvent, planGenerate, planStageOp, type SidecarJobEvent } from './progress';

function baseEvent(overrides: Partial<SidecarJobEvent>): SidecarJobEvent {
  return {
    jobId: 'j1',
    stage: 'geometry',
    stageIndex: 0,
    message: '',
    done: false,
    ...overrides,
  };
}

describe('planGenerate', () => {
  it('text with texture runs image → geometry → texture, weights sum to 1', () => {
    const plan = planGenerate('text', true);
    expect(plan.map((s) => s.stage)).toEqual(['image', 'geometry', 'texture']);
    expect(plan.reduce((a, s) => a + s.weight, 0)).toBeCloseTo(1);
  });

  it('image without texture is geometry-only at full weight', () => {
    expect(planGenerate('image', false)).toEqual([{ stage: 'geometry', weight: 1 }]);
  });

  it('every plan variant sums to 1', () => {
    for (const kind of ['text', 'image'] as const) {
      for (const texture of [true, false]) {
        const total = planGenerate(kind, texture).reduce((a, s) => a + s.weight, 0);
        expect(total).toBeCloseTo(1);
      }
    }
  });

  it('stage ops are single full-weight stages', () => {
    expect(planStageOp('retopo')).toEqual([{ stage: 'retopo', weight: 1 }]);
  });
});

describe('mapJobEvent', () => {
  const plan = planGenerate('text', true); // image .12 / geometry .58 / texture .30

  it('maps mid-stage steps into stage and overall percents', () => {
    const update = mapJobEvent(
      plan,
      baseEvent({ stage: 'geometry', stageIndex: 1, step: 6, totalSteps: 12, message: 'Shape' }),
    );
    expect(update.stagePercent).toBe(50);
    // 12% (image done) + 58% * 50% = 41%
    expect(update.overallPercent).toBe(41);
    expect(update.done).toBe(false);
  });

  it('stageDone pins the stage at 100 and advances overall to the boundary', () => {
    const update = mapJobEvent(
      plan,
      baseEvent({ stage: 'image', stageIndex: 0, stageDone: true, message: 'Image generated' }),
    );
    expect(update.stagePercent).toBe(100);
    expect(update.overallPercent).toBe(12);
  });

  it('done without error is always 100/100', () => {
    const update = mapJobEvent(
      plan,
      baseEvent({ stage: 'texture', stageIndex: 2, done: true, stageDone: true }),
    );
    expect(update.overallPercent).toBe(100);
    expect(update.stagePercent).toBe(100);
  });

  it('errors pass through and do not force 100', () => {
    const update = mapJobEvent(
      plan,
      baseEvent({ stage: 'geometry', stageIndex: 1, done: true, error: 'watchdog' }),
    );
    expect(update.error).toBe('watchdog');
    expect(update.done).toBe(true);
    expect(update.overallPercent).toBeLessThan(100);
  });

  it('artifacts pass through untouched (geometry-first contract)', () => {
    const artifact = {
      kind: 'model-glb' as const,
      path: '/tmp/geometry.glb',
      label: 'Untextured geometry',
    };
    const update = mapJobEvent(plan, baseEvent({ stage: 'geometry', stageIndex: 1, artifact }));
    expect(update.artifact).toEqual(artifact);
  });

  it('is defensive about out-of-range stageIndex', () => {
    const update = mapJobEvent(plan, baseEvent({ stageIndex: 9, step: 1, totalSteps: 2 }));
    expect(update.overallPercent).toBeLessThanOrEqual(100);
    expect(update.overallPercent).toBeGreaterThanOrEqual(0);
  });
});
