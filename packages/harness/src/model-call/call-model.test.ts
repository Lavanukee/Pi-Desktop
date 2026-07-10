import { describe, expect, it } from 'vitest';
import {
  callModelFromEnv,
  createOpenAiCompatCallModel,
  UTILITY_BASE_URL_ENV,
  UTILITY_MODEL_ENV,
} from './call-model.js';

function jsonFetch(content: string): {
  fetchImpl: typeof fetch;
  calls: RequestInit[];
  urls: string[];
} {
  const calls: RequestInit[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(url);
    calls.push(init);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, urls };
}

describe('createOpenAiCompatCallModel', () => {
  it('POSTs to <base>/chat/completions and returns the message content', async () => {
    const { fetchImpl, calls, urls } = jsonFetch('hello world');
    const callModel = createOpenAiCompatCallModel({
      baseUrl: 'http://127.0.0.1:8080/v1/',
      model: 'gemma',
      apiKey: 'secret',
      fetchImpl,
    });
    const out = await callModel({ system: 'sys', prompt: 'hi', maxTokens: 32 });
    expect(out).toBe('hello world');
    // Trailing slash trimmed exactly once.
    expect(urls[0]).toBe('http://127.0.0.1:8080/v1/chat/completions');
    const body = JSON.parse(calls[0]?.body as string);
    expect(body.model).toBe('gemma');
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(32);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret');
  });

  it('throws on a non-OK response', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 503 }) as unknown as Response) as unknown as typeof fetch;
    const callModel = createOpenAiCompatCallModel({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetchImpl,
    });
    await expect(callModel({ prompt: 'hi' })).rejects.toThrow(/503/);
  });
});

describe('callModelFromEnv', () => {
  it('returns undefined when no base URL is configured', () => {
    expect(callModelFromEnv({})).toBeUndefined();
    expect(callModelFromEnv({ [UTILITY_BASE_URL_ENV]: '' })).toBeUndefined();
  });

  it('builds a working callModel from env vars', async () => {
    const { fetchImpl, urls } = jsonFetch('ok');
    const callModel = callModelFromEnv(
      { [UTILITY_BASE_URL_ENV]: 'http://127.0.0.1:9000/v1', [UTILITY_MODEL_ENV]: 'utility-x' },
      fetchImpl,
    );
    expect(callModel).toBeDefined();
    const out = await callModel?.({ prompt: 'ping' });
    expect(out).toBe('ok');
    expect(urls[0]).toBe('http://127.0.0.1:9000/v1/chat/completions');
  });
});
