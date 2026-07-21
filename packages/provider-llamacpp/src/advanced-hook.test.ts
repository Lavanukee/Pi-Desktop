import { describe, expect, it } from 'vitest';
import {
  applySamplingOverride,
  createSamplingReader,
  extractGroundTruth,
  type SamplingOverride,
} from './advanced-hook.js';

describe('applySamplingOverride', () => {
  it('stamps the OpenAI/llama.cpp field names, skipping undefined', () => {
    const o: SamplingOverride = {
      temperature: 0.3,
      topP: 0.85,
      topK: 40,
      minP: 0.05,
      repetitionPenalty: 1.1,
      presencePenalty: 0.5,
    };
    const body = applySamplingOverride({ model: 'm', messages: [] }, o);
    expect(body).toMatchObject({
      temperature: 0.3,
      top_p: 0.85,
      top_k: 40,
      min_p: 0.05,
      repeat_penalty: 1.1,
      presence_penalty: 0.5,
    });
    expect('max_tokens' in body).toBe(false); // maxTokens absent → unset
  });

  it('treats maxTokens 0 as unset but sends a positive cap', () => {
    expect('max_tokens' in applySamplingOverride({}, { maxTokens: 0 })).toBe(false);
    expect(applySamplingOverride({}, { maxTokens: 512 }).max_tokens).toBe(512);
  });

  it('is a no-op for a null override (server defaults stand)', () => {
    expect(applySamplingOverride({ messages: [] }, null)).toEqual({ messages: [] });
  });
});

describe('extractGroundTruth', () => {
  it('pulls the system prompt, tools, messages, and model from a chat body', () => {
    const gt = extractGroundTruth({
      model: 'gemma',
      messages: [
        { role: 'system', content: 'you are pi' },
        { role: 'user', content: 'hi' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'read', description: 'read a file', parameters: {} },
        },
      ],
    });
    expect(gt).not.toBeNull();
    expect(gt?.systemPrompt).toBe('you are pi');
    expect(gt?.model).toBe('gemma');
    expect(gt?.tools).toEqual([{ name: 'read', description: 'read a file', parameters: {} }]);
    expect(gt?.messages).toHaveLength(2);
  });

  it('returns an empty system prompt when the first message is not a system turn', () => {
    const gt = extractGroundTruth({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(gt?.systemPrompt).toBe('');
  });

  it('returns null for a non-chat payload (safe no-op on other providers)', () => {
    expect(extractGroundTruth(null)).toBeNull();
    expect(extractGroundTruth({ prompt: 'raw' })).toBeNull();
    expect(extractGroundTruth(42)).toBeNull();
  });
});

describe('createSamplingReader', () => {
  it('returns null when no path is configured', () => {
    expect(createSamplingReader(undefined)()).toBeNull();
  });

  it('reads + parses the file and re-reads only when the mtime changes', () => {
    let mtimeMs = 1;
    let contents = JSON.stringify({ temperature: 0.5 });
    let reads = 0;
    const read = createSamplingReader('/x.json', {
      stat: (() => ({ mtimeMs })) as never,
      readFile: (() => {
        reads += 1;
        return contents;
      }) as never,
    });
    expect(read()).toEqual({ temperature: 0.5 });
    expect(read()).toEqual({ temperature: 0.5 }); // same mtime → cached
    expect(reads).toBe(1);
    mtimeMs = 2;
    contents = JSON.stringify({ temperature: 0.9 });
    expect(read()).toEqual({ temperature: 0.9 }); // mtime bumped → re-read
    expect(reads).toBe(2);
  });

  it('degrades to null on a missing/corrupt file', () => {
    const read = createSamplingReader('/x.json', {
      stat: (() => {
        throw new Error('ENOENT');
      }) as never,
    });
    expect(read()).toBeNull();
  });
});
