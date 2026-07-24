import { describe, expect, it } from 'vitest';
import { prefillCompletion } from './prefill-completion.js';

/** A fake fetch returning one non-streamed /chat/completions JSON reply. */
function makeFetch(opts: { status?: number; usagePromptTokens?: number }): {
  fetchImpl: typeof fetch;
  urls: string[];
  bodies: Array<Record<string, unknown>>;
} {
  const urls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(url);
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return {
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      statusText: 'OK',
      json: async () => ({
        choices: [{ message: { content: '.' } }],
        usage: { prompt_tokens: opts.usagePromptTokens ?? 2500 },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, urls, bodies };
}

describe('prefillCompletion', () => {
  it('POSTs a one-token, no-thinking chat completion to the /v1 endpoint', async () => {
    const { fetchImpl, urls, bodies } = makeFetch({ usagePromptTokens: 2517 });
    const result = await prefillCompletion({
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'qwen',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'a big pasted block' },
      ],
      fetchImpl,
    });

    expect(urls).toEqual(['http://127.0.0.1:8080/v1/chat/completions']);
    const body = bodies[0];
    expect(body?.max_tokens).toBe(1);
    expect(body?.temperature).toBe(0);
    expect(body?.stream).toBe(false);
    expect(body?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(result).toEqual({ aborted: false, promptN: 2517 });
  });

  it('maps tools to OpenAI function shape, in order', async () => {
    const { fetchImpl, bodies } = makeFetch({});
    await prefillCompletion({
      baseUrl: 'http://127.0.0.1:8080/v1',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'read_file', description: 'read', parameters: { type: 'object' } },
        { name: 'write_file' },
      ],
      fetchImpl,
    });
    expect(bodies[0]?.tools).toEqual([
      {
        type: 'function',
        function: { name: 'read_file', description: 'read', parameters: { type: 'object' } },
      },
      {
        type: 'function',
        function: { name: 'write_file', description: undefined, parameters: undefined },
      },
    ]);
  });

  it('omits tools entirely when none are given', async () => {
    const { fetchImpl, bodies } = makeFetch({});
    await prefillCompletion({
      baseUrl: 'http://127.0.0.1:8080/v1',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });
    expect(bodies[0]).not.toHaveProperty('tools');
  });

  it('resolves aborted:true (never throws) when the signal aborts', async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => {
      controller.abort();
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;
    const result = await prefillCompletion({
      baseUrl: 'http://127.0.0.1:8080/v1',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
      signal: controller.signal,
    });
    expect(result).toEqual({ aborted: true });
  });

  it('throws on a real server error (non-abort)', async () => {
    const { fetchImpl } = makeFetch({ status: 500 });
    await expect(
      prefillCompletion({
        baseUrl: 'http://127.0.0.1:8080/v1',
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl,
      }),
    ).rejects.toThrow(/server returned 500/);
  });
});
