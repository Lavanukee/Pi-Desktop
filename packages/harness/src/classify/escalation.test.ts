import { describe, expect, it, vi } from 'vitest';
import type { CallModel } from '../model-call/call-model.js';
import { classify, classifyWithEscalation } from './classify.js';
import { createClassifierEscalation } from './escalation.js';

const AMBIGUOUS = 'edit this video footage into an animated motion graphics reel';

describe('createClassifierEscalation', () => {
  it('picks the class named by the utility model', async () => {
    const callModel: CallModel = vi.fn(async () => 'motion-graphics');
    const escalate = createClassifierEscalation(callModel);
    const r = await escalate({ prompt: AMBIGUOUS }, classify({ prompt: AMBIGUOUS }));
    expect(r?.class).toBe('motion-graphics');
    expect(r?.signals).toContain('tier2-escalation');
  });

  it('prefers the longest matching class name', async () => {
    const callModel: CallModel = vi.fn(async () => 'this is advanced-video work');
    const escalate = createClassifierEscalation(callModel);
    const r = await escalate({ prompt: AMBIGUOUS }, classify({ prompt: AMBIGUOUS }));
    expect(r?.class).toBe('advanced-video');
  });

  it('returns undefined (keep tier 1) when no class is named or the call fails', async () => {
    const noMatch = createClassifierEscalation(vi.fn(async () => 'no idea'));
    expect(await noMatch({ prompt: AMBIGUOUS }, classify({ prompt: AMBIGUOUS }))).toBeUndefined();
    const boom = createClassifierEscalation(
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await boom({ prompt: AMBIGUOUS }, classify({ prompt: AMBIGUOUS }))).toBeUndefined();
  });

  it('drives classifyWithEscalation end-to-end on an ambiguous prompt', async () => {
    const callModel: CallModel = vi.fn(async () => '3d');
    const r = await classifyWithEscalation(
      { prompt: AMBIGUOUS },
      { asyncClassifier: createClassifierEscalation(callModel) },
    );
    expect(r.class).toBe('3d');
    expect(callModel).toHaveBeenCalledOnce();
  });
});
