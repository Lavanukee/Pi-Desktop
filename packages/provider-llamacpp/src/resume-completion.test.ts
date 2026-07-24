import { describe, expect, it } from 'vitest';
import {
  buildApplyTemplateBody,
  buildCompletionBody,
  llamaServerRoot,
  type PartialBlock,
  resumeCompletion,
  serializePartialAssistant,
} from './resume-completion.js';

describe('llamaServerRoot', () => {
  it('strips a trailing /v1 to reach the raw server root', () => {
    expect(llamaServerRoot('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080');
  });
  it('tolerates trailing slashes', () => {
    expect(llamaServerRoot('http://127.0.0.1:8080/v1/')).toBe('http://127.0.0.1:8080');
    expect(llamaServerRoot('http://127.0.0.1:8080///')).toBe('http://127.0.0.1:8080');
  });
  it('is a no-op for a root that already lacks /v1', () => {
    expect(llamaServerRoot('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });
});

describe('buildApplyTemplateBody', () => {
  it('renders with add_generation_prompt + the enable_thinking kwarg', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    expect(buildApplyTemplateBody(messages, true)).toEqual({
      messages,
      add_generation_prompt: true,
      chat_template_kwargs: { enable_thinking: true },
    });
    expect(buildApplyTemplateBody(messages, false).chat_template_kwargs.enable_thinking).toBe(
      false,
    );
  });
});

describe('buildCompletionBody', () => {
  it('appends the partial to the rendered prompt and reuses the KV', () => {
    const body = buildCompletionBody({
      renderedPrompt: '<|im_start|>assistant\n',
      partialText: 'The answer is',
    });
    expect(body.prompt).toBe('<|im_start|>assistant\nThe answer is');
    expect(body.cache_prompt).toBe(true);
    expect(body.stream).toBe(true);
    expect(body.n_predict).toBe(-1);
    expect(body.temperature).toBeUndefined();
  });
  it('carries temperature + an explicit n_predict when given', () => {
    const body = buildCompletionBody({
      renderedPrompt: 'P',
      partialText: 'Q',
      temperature: 0.7,
      nPredict: 256,
    });
    expect(body.temperature).toBe(0.7);
    expect(body.n_predict).toBe(256);
  });
});

describe('serializePartialAssistant', () => {
  it('joins plain text blocks verbatim', () => {
    const blocks: PartialBlock[] = [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
    ];
    expect(serializePartialAssistant(blocks)).toBe('Hello world');
  });
  it('re-wraps a CLOSED thinking block (followed by the answer) in <think></think>', () => {
    const blocks: PartialBlock[] = [
      { type: 'thinking', thinking: 'reason' },
      { type: 'text', text: 'answer' },
    ];
    expect(serializePartialAssistant(blocks)).toBe('<think>\nreason\n</think>\n\nanswer');
  });
  it('leaves a trailing (still-open) thinking block UNclosed', () => {
    const blocks: PartialBlock[] = [{ type: 'thinking', thinking: 'half a thought' }];
    expect(serializePartialAssistant(blocks)).toBe('<think>\nhalf a thought');
  });
  it('is empty for no blocks', () => {
    expect(serializePartialAssistant([])).toBe('');
  });
});

/** A fake fetch: one JSON /apply-template response, then a streamed /completion. */
function makeFetch(opts: {
  prompt: string;
  frames: unknown[];
  templateStatus?: number;
  completionStatus?: number;
}): { fetchImpl: typeof fetch; urls: string[]; bodies: unknown[] } {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(url);
    bodies.push(JSON.parse(String(init.body)));
    if (url.endsWith('/apply-template')) {
      return {
        ok: (opts.templateStatus ?? 200) < 400,
        status: opts.templateStatus ?? 200,
        statusText: 'OK',
        json: async () => ({ prompt: opts.prompt }),
      } as unknown as Response;
    }
    async function* body(): AsyncGenerator<Uint8Array> {
      const enc = new TextEncoder();
      for (const f of opts.frames) yield enc.encode(`data: ${JSON.stringify(f)}\n\n`);
    }
    return {
      ok: (opts.completionStatus ?? 200) < 400,
      status: opts.completionStatus ?? 200,
      statusText: 'OK',
      body: body(),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, urls, bodies };
}

describe('resumeCompletion', () => {
  it('renders the template then streams a continuation, accumulating tokens', async () => {
    const { fetchImpl, urls, bodies } = makeFetch({
      prompt: 'RENDERED\n',
      frames: [
        { content: ' is', stop: false },
        { content: ' 42', stop: false },
        { content: '.', stop: true, timings: { prompt_n: 1, predicted_n: 3 } },
      ],
    });
    const tokens: string[] = [];
    const result = await resumeCompletion({
      baseUrl: 'http://127.0.0.1:8080/v1',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'the answer' },
      ],
      partialText: 'The answer',
      enableThinking: false,
      temperature: 0.8,
      fetchImpl,
      onToken: (t) => tokens.push(t),
    });

    // Hit the RAW server root (no /v1) on both endpoints, in order.
    expect(urls).toEqual([
      'http://127.0.0.1:8080/apply-template',
      'http://127.0.0.1:8080/completion',
    ]);
    // The /completion prompt is the rendered prompt + the partial (KV reuse).
    expect((bodies[1] as { prompt: string }).prompt).toBe('RENDERED\nThe answer');
    expect((bodies[1] as { cache_prompt: boolean }).cache_prompt).toBe(true);
    expect((bodies[1] as { temperature: number }).temperature).toBe(0.8);
    // apply-template opts into add_generation_prompt + the enable_thinking kwarg.
    expect((bodies[0] as { add_generation_prompt: boolean }).add_generation_prompt).toBe(true);

    expect(tokens).toEqual([' is', ' 42', '.']);
    expect(result.text).toBe(' is 42.');
    expect(result.stopped).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.promptN).toBe(1); // resident KV → ~0 re-prefill
  });

  it('resolves cleanly (aborted:true, no throw) when the signal aborts', async () => {
    const controller = new AbortController();
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/apply-template')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ prompt: 'P' }),
        } as unknown as Response;
      }
      controller.abort();
      // eslint-disable-next-line no-throw-literal
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }) as unknown as typeof fetch;

    const result = await resumeCompletion({
      baseUrl: 'http://127.0.0.1:8080/v1',
      messages: [{ role: 'user', content: 'x' }],
      partialText: 'partial',
      enableThinking: false,
      fetchImpl,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.text).toBe('');
  });

  it('throws on a non-abort apply-template failure', async () => {
    const { fetchImpl } = makeFetch({ prompt: '', frames: [], templateStatus: 500 });
    await expect(
      resumeCompletion({
        baseUrl: 'http://127.0.0.1:8080/v1',
        messages: [{ role: 'user', content: 'x' }],
        partialText: 'p',
        enableThinking: false,
        fetchImpl,
      }),
    ).rejects.toThrow(/apply-template/);
  });

  it('skips malformed SSE frames without failing the stream', async () => {
    // A raw non-JSON payload before a valid final frame must not abort the stream.
    const bad = (async (url: string) => {
      if (url.endsWith('/apply-template')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ prompt: 'P' }),
        } as unknown as Response;
      }
      async function* body(): AsyncGenerator<Uint8Array> {
        const enc = new TextEncoder();
        yield enc.encode('data: {bad json\n\n');
        yield enc.encode(`data: ${JSON.stringify({ content: 'ok', stop: true })}\n\n`);
      }
      return { ok: true, status: 200, body: body() } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await resumeCompletion({
      baseUrl: 'http://127.0.0.1:8080',
      messages: [{ role: 'user', content: 'x' }],
      partialText: 'p',
      enableThinking: false,
      fetchImpl: bad,
    });
    expect(result.text).toBe('ok');
  });
});
