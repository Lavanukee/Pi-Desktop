import { describe, expect, it } from 'vitest';
import { prefillCompletion, truncateToPrefix } from './prefill-completion.js';

/** A fake fetch: a JSON /apply-template reply, then a JSON /completion reply. */
function makeFetch(opts: {
  prompt?: string;
  tokensEvaluated?: number;
  templateStatus?: number;
  completionStatus?: number;
}): { fetchImpl: typeof fetch; urls: string[]; bodies: Array<Record<string, unknown>> } {
  const urls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(url);
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    if (url.endsWith('/apply-template')) {
      return {
        ok: (opts.templateStatus ?? 200) < 400,
        status: opts.templateStatus ?? 200,
        statusText: 'OK',
        json: async () => ({ prompt: opts.prompt ?? 'SYS<user>ATTACH<|im_end|>\nASSIST' }),
      } as unknown as Response;
    }
    return {
      ok: (opts.completionStatus ?? 200) < 400,
      status: opts.completionStatus ?? 200,
      statusText: 'OK',
      json: async () => ({ tokens_evaluated: opts.tokensEvaluated ?? 4943 }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, urls, bodies };
}

describe('truncateToPrefix', () => {
  it('cuts right after the last message content (drops the message close)', () => {
    const messages = [{ role: 'user', content: 'ATTACH' }];
    expect(truncateToPrefix('SYS<user>ATTACH<|im_end|>\nASSIST', messages)).toBe('SYS<user>ATTACH');
  });
  it('uses the LAST occurrence (attachment echoed earlier in history)', () => {
    const messages = [{ role: 'user', content: 'ATTACH' }];
    expect(truncateToPrefix('...ATTACH...more...ATTACH<|im_end|>', messages)).toBe(
      '...ATTACH...more...ATTACH',
    );
  });
  it('falls back to the full render when the marker is absent', () => {
    const messages = [{ role: 'user', content: 'NOPE' }];
    expect(truncateToPrefix('SYS<user>ATTACH<|im_end|>', messages)).toBe(
      'SYS<user>ATTACH<|im_end|>',
    );
  });
});

describe('prefillCompletion', () => {
  it('renders via /apply-template (with tools) then primes the raw prefix via /completion', async () => {
    const { fetchImpl, urls, bodies } = makeFetch({
      prompt: 'SYS[tools]<user>\nATTACH<|im_end|>\n<assistant>',
      tokensEvaluated: 4943,
    });
    const result = await prefillCompletion({
      baseUrl: 'http://127.0.0.1:8080/v1',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'ATTACH' },
      ],
      tools: [{ name: 'read', description: 'r', parameters: { type: 'object' } }],
      fetchImpl,
    });
    // Hits the RAW root (no /v1) on both endpoints, in order.
    expect(urls).toEqual([
      'http://127.0.0.1:8080/apply-template',
      'http://127.0.0.1:8080/completion',
    ]);
    // apply-template body: no generation prompt, thinking off, tools mapped.
    expect(bodies[0]?.add_generation_prompt).toBe(false);
    expect(bodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(bodies[0]?.tools).toEqual([
      {
        type: 'function',
        function: { name: 'read', description: 'r', parameters: { type: 'object' } },
      },
    ]);
    // completion body: the TRUNCATED raw prefix (message close dropped), cache_prompt.
    expect(bodies[1]?.prompt).toBe('SYS[tools]<user>\nATTACH');
    expect(bodies[1]?.cache_prompt).toBe(true);
    expect(bodies[1]?.n_predict).toBe(1);
    expect(result).toEqual({ aborted: false, promptN: 4943 });
  });

  it('omits tools from apply-template when none are given', async () => {
    const { fetchImpl, bodies } = makeFetch({});
    await prefillCompletion({
      baseUrl: 'http://127.0.0.1:8080/v1',
      messages: [{ role: 'user', content: 'ATTACH' }],
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
      messages: [{ role: 'user', content: 'ATTACH' }],
      fetchImpl,
      signal: controller.signal,
    });
    expect(result).toEqual({ aborted: true });
  });

  it('throws on a real apply-template error (non-abort)', async () => {
    const { fetchImpl } = makeFetch({ templateStatus: 500 });
    await expect(
      prefillCompletion({
        baseUrl: 'http://127.0.0.1:8080/v1',
        messages: [{ role: 'user', content: 'ATTACH' }],
        fetchImpl,
      }),
    ).rejects.toThrow(/apply-template: server returned 500/);
  });
});
