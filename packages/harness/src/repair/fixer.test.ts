import { describe, expect, it, vi } from 'vitest';
import type { CallModel } from '../model-call/call-model.js';
import { createToolCallFixer, extractJsonObject, withRepairAttempts } from './fixer.js';
import type { ToolSchemaLike } from './types.js';

const SCHEMA: ToolSchemaLike = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
};

describe('extractJsonObject', () => {
  it('parses a bare object', () => {
    expect(extractJsonObject('{"path":"/etc/hosts"}')).toEqual({ path: '/etc/hosts' });
  });
  it('strips a ```json fence and surrounding prose', () => {
    const text = 'Here you go:\n```json\n{"path":"/a"}\n```\nDone.';
    expect(extractJsonObject(text)).toEqual({ path: '/a' });
  });
  it('returns undefined when there is no object', () => {
    expect(extractJsonObject('no json here')).toBeUndefined();
    expect(extractJsonObject('[1,2,3]')).toBeUndefined();
  });
});

describe('createToolCallFixer', () => {
  it('asks the model and returns the corrected object', async () => {
    const callModel: CallModel = vi.fn(async () => '```json\n{"path":"/fixed"}\n```');
    const fixer = createToolCallFixer(callModel);
    const out = await fixer({ raw: '{"wrong":1}', toolName: 'read', schema: SCHEMA, error: 'x' });
    expect(out).toEqual({ path: '/fixed' });
    expect(callModel).toHaveBeenCalledOnce();
  });

  it('returns undefined when the model call throws (→ skip to rung 3)', async () => {
    const callModel: CallModel = vi.fn(async () => {
      throw new Error('offline');
    });
    const fixer = createToolCallFixer(callModel);
    expect(
      await fixer({ raw: '{}', toolName: 'read', schema: SCHEMA, error: 'x' }),
    ).toBeUndefined();
  });
});

describe('withRepairAttempts', () => {
  it('retries up to `attempts` times until a result is produced', async () => {
    let n = 0;
    const flaky = vi.fn(async () => {
      n += 1;
      return n < 3 ? undefined : { path: '/ok' };
    });
    const wrapped = withRepairAttempts(flaky, 5);
    const out = await wrapped({ raw: '', toolName: 't', schema: SCHEMA, error: 'e' });
    expect(out).toEqual({ path: '/ok' });
    expect(flaky).toHaveBeenCalledTimes(3);
  });

  it('bounds retries: low effort (1 attempt) tries once and gives up', async () => {
    const always = vi.fn(async () => undefined);
    const wrapped = withRepairAttempts(always, 1);
    expect(await wrapped({ raw: '', toolName: 't', schema: SCHEMA, error: 'e' })).toBeUndefined();
    expect(always).toHaveBeenCalledTimes(1);
  });
});
