import { describe, expect, it, vi } from 'vitest';
import type { CallModel, CallModelRequest } from '../model-call/call-model.js';
import { type ClassifyMessage, classify, classifyWithEscalation } from './classify.js';
import { createClassifierEscalation } from './escalation.js';

const AMBIGUOUS = 'edit this video footage into an animated motion graphics reel';

/** A CallModel spy that returns a fixed body and records the request. */
function spyModel(reply: string): { callModel: CallModel; reqs: CallModelRequest[] } {
  const reqs: CallModelRequest[] = [];
  const callModel: CallModel = vi.fn(async (req: CallModelRequest) => {
    reqs.push(req);
    return reply;
  });
  return { callModel, reqs };
}

describe('createClassifierEscalation — {title, class} piggyback', () => {
  it('parses the class AND the title from the structured reply', async () => {
    const { callModel } = spyModel('{"title": "Motion graphics reel", "class": "motion-graphics"}');
    const escalate = createClassifierEscalation(callModel);
    const r = await escalate({ prompt: AMBIGUOUS }, classify({ prompt: AMBIGUOUS }));
    expect(r?.class).toBe('motion-graphics');
    expect(r?.title).toBe('Motion graphics reel');
    expect(r?.signals).toContain('tier2-piggyback');
  });

  it('tolerates prose wrapped around the JSON object', async () => {
    const { callModel } = spyModel('Sure! {"title":"Auth refactor","class":"coding"} done.');
    const r = await createClassifierEscalation(callModel)(
      { prompt: 'x' },
      classify({ prompt: 'x' }),
    );
    expect(r?.class).toBe('coding');
    expect(r?.title).toBe('Auth refactor');
  });

  it('prefers the longest matching class name', async () => {
    const { callModel } = spyModel('{"title":"Edit","class":"advanced-video work"}');
    const r = await createClassifierEscalation(callModel)(
      { prompt: AMBIGUOUS },
      classify({ prompt: AMBIGUOUS }),
    );
    expect(r?.class).toBe('advanced-video');
  });

  it('keeps the heuristic class but still surfaces the title when class is unusable', async () => {
    const tier1 = classify({ prompt: AMBIGUOUS });
    const { callModel } = spyModel('{"title":"A good title","class":"nonsense"}');
    const r = await createClassifierEscalation(callModel)({ prompt: AMBIGUOUS }, tier1);
    expect(r?.class).toBe(tier1.class);
    expect(r?.title).toBe('A good title');
  });

  it('returns undefined (keep tier 1) on malformed output or a failed call', async () => {
    const noJson = createClassifierEscalation(spyModel('no idea').callModel);
    expect(await noJson({ prompt: AMBIGUOUS }, classify({ prompt: AMBIGUOUS }))).toBeUndefined();
    const boom = createClassifierEscalation(
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await boom({ prompt: AMBIGUOUS }, classify({ prompt: AMBIGUOUS }))).toBeUndefined();
  });

  it('SHARES the conversation prefix + appends only a short instruction (cache reuse)', async () => {
    const priorMessages: ClassifyMessage[] = [
      { role: 'system', content: 'You are Pi.' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: AMBIGUOUS },
    ];
    const { callModel, reqs } = spyModel('{"title":"Reel","class":"motion-graphics"}');
    await createClassifierEscalation(callModel)(
      { prompt: AMBIGUOUS, priorMessages },
      classify({ prompt: AMBIGUOUS }),
    );
    const sent = reqs[0]?.messages ?? [];
    // The request is the exact live prefix + ONE short trailing instruction.
    expect(sent.slice(0, priorMessages.length)).toEqual(priorMessages);
    expect(sent).toHaveLength(priorMessages.length + 1);
    expect(sent.at(-1)?.role).toBe('user');
    // A grammar/JSON-schema response_format constrains the tiny reply, and a
    // no-thinking hint keeps a reasoning model fast.
    expect(reqs[0]?.responseFormat).toBeDefined();
    expect(reqs[0]?.extraBody).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('falls back to the bare prompt when no conversation prefix is supplied', async () => {
    const { callModel, reqs } = spyModel('{"title":"Q","class":"coding"}');
    await createClassifierEscalation(callModel)(
      { prompt: 'refactor things' },
      classify({ prompt: 'refactor things' }),
    );
    const sent = reqs[0]?.messages ?? [];
    expect(sent[0]).toEqual({ role: 'user', content: 'refactor things' });
  });

  it('drives classifyWithEscalation end-to-end on an ambiguous prompt', async () => {
    const { callModel } = spyModel('{"title":"3D thing","class":"3d"}');
    const r = await classifyWithEscalation(
      { prompt: AMBIGUOUS },
      { asyncClassifier: createClassifierEscalation(callModel) },
    );
    expect(r.class).toBe('3d');
    expect(r.title).toBe('3D thing');
    expect(callModel).toHaveBeenCalledOnce();
  });
});

describe('classifyWithEscalation — forceEscalate (turn-1 title)', () => {
  it('keeps the confident heuristic class but carries the model title', async () => {
    // "Refactor the auth module." is confidently `coding` (unambiguous).
    const { callModel } = spyModel('{"title":"Auth refactor","class":"motion-graphics"}');
    const r = await classifyWithEscalation(
      { prompt: 'Refactor the auth module.' },
      { asyncClassifier: createClassifierEscalation(callModel), forceEscalate: true },
    );
    // Class stays with the fast heuristic; only the title comes from the model.
    expect(r.class).toBe('coding');
    expect(r.title).toBe('Auth refactor');
    expect(callModel).toHaveBeenCalledOnce();
  });

  it('does not consult the model without forceEscalate on a confident turn', async () => {
    const { callModel } = spyModel('{"title":"x","class":"3d"}');
    await classifyWithEscalation(
      { prompt: 'Refactor the auth module.' },
      { asyncClassifier: createClassifierEscalation(callModel) },
    );
    expect(callModel).not.toHaveBeenCalled();
  });
});
