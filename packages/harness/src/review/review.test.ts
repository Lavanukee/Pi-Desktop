import { describe, expect, it, vi } from 'vitest';
import type { CallModel } from '../model-call/call-model.js';
import { adversarialCheck, parseReview, reviewOutput } from './review.js';

describe('parseReview', () => {
  it('parses a clean pass', () => {
    expect(parseReview('{"ok":true,"issues":[]}')).toMatchObject({ ok: true, issues: [] });
  });
  it('parses a flagged result with issues', () => {
    const r = parseReview('The result is wrong. {"ok":false,"issues":["missing edge case"]}');
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual(['missing edge case']);
  });
  it('fails open on unparseable output', () => {
    expect(parseReview('lgtm').ok).toBe(true);
  });
});

describe('reviewOutput / adversarialCheck', () => {
  it('flags a bad result', async () => {
    const callModel: CallModel = vi.fn(async () => '{"ok":false,"issues":["off-by-one"]}');
    const r = await reviewOutput(callModel, { task: 'sum', output: 'wrong' });
    expect(r.ok).toBe(false);
    expect(r.issues).toContain('off-by-one');
  });

  it('passes a good result', async () => {
    const callModel: CallModel = vi.fn(async () => '{"ok":true,"issues":[]}');
    const r = await adversarialCheck(callModel, { task: 'sum', output: '4' });
    expect(r.ok).toBe(true);
  });

  it('fails open when the model call throws', async () => {
    const callModel: CallModel = vi.fn(async () => {
      throw new Error('offline');
    });
    const r = await reviewOutput(callModel, { task: 't', output: 'o' });
    expect(r.ok).toBe(true);
  });
});
