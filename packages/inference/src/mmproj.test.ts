import { describe, expect, it } from 'vitest';
import type { CatalogFile, CatalogModel } from './catalog.js';
import { mmprojFileFor, modelSupportsVision, planVisionLaunch } from './mmproj.js';

const MMPROJ: CatalogFile = { name: 'mmproj-F16.gguf', bytes: 0, quant: 'F16' };

const visionModel = { mmproj: MMPROJ } satisfies Pick<CatalogModel, 'mmproj'>;
const textModel = { mmproj: undefined } satisfies Pick<CatalogModel, 'mmproj'>;

describe('modelSupportsVision', () => {
  it('is true iff the model ships an mmproj projector', () => {
    expect(modelSupportsVision(visionModel)).toBe(true);
    expect(modelSupportsVision(textModel)).toBe(false);
  });
});

describe('mmprojFileFor — the lazy chokepoint', () => {
  it('NEVER resolves an mmproj for a fast-text launch, even on a vision model', () => {
    // The core lazy guarantee: a text launch cannot even name a projector.
    expect(mmprojFileFor(visionModel, 'fast-text')).toBeUndefined();
    expect(mmprojFileFor(textModel, 'fast-text')).toBeUndefined();
  });

  it('resolves the projector only for a multimodal launch of a vision model', () => {
    expect(mmprojFileFor(visionModel, 'multimodal')).toBe(MMPROJ);
  });

  it('returns undefined for a multimodal launch of a model with no projector', () => {
    expect(mmprojFileFor(textModel, 'multimodal')).toBeUndefined();
  });
});

describe('planVisionLaunch — lazy transition policy', () => {
  it('a text turn is ALWAYS stay-text, regardless of running mode', () => {
    // This is the guarantee that a pure-text session never loads the projector.
    for (const runningMode of ['fast-text', 'multimodal', undefined] as const) {
      expect(planVisionLaunch({ runningMode, turnHasImage: false })).toEqual({ kind: 'stay-text' });
    }
  });

  it('an image turn on a text-only server requires an mmproj load (restart)', () => {
    expect(planVisionLaunch({ runningMode: 'fast-text', turnHasImage: true })).toEqual({
      kind: 'load-mmproj',
    });
  });

  it('an image turn with no server up yet requires an mmproj load', () => {
    expect(planVisionLaunch({ runningMode: undefined, turnHasImage: true })).toEqual({
      kind: 'load-mmproj',
    });
  });

  it('an image turn on an already-multimodal server is a no-op (vision is sticky)', () => {
    expect(planVisionLaunch({ runningMode: 'multimodal', turnHasImage: true })).toEqual({
      kind: 'already-vision',
    });
  });
});
