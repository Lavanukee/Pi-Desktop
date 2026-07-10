/**
 * Registration/regression tests for the provider extension.
 *
 * These drive pi's REAL machinery (imported from the installed
 * @mariozechner/pi-coding-agent + @mariozechner/pi-ai) — not a re-implementation
 * — so they lock in the exact contract that broke:
 *
 *   1. Registering `streamSimple` WITHOUT an `api` throws pi's validation error
 *      (`"api" is required when registering streamSimple`) — the original crash.
 *   2. Our fixed config (with {@link LLAMACPP_API}) passes pi's validation.
 *   3. After registration, pi's api-registry resolves OUR streamSimple for a
 *      model whose `api === LLAMACPP_API` (non-bypass: repair/TPS run), while the
 *      built-in `openai-completions` handler is left untouched (non-hijack), and
 *      pi's mismatch guard hard-binds our handler to LLAMACPP_API.
 */
import {
  type Api,
  type AssistantMessageEvent,
  type Context,
  getApiProvider,
  type Model,
  resetApiProviders,
} from '@mariozechner/pi-ai';
import { AuthStorage, type ExtensionAPI, ModelRegistry } from '@mariozechner/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LLAMACPP_API, registerLlamaCppProvider } from './index.js';
import type { LlamaCppStreamDeps } from './stream.js';

/** A fake pi (ExtensionAPI) that records the single provider config registered. */
function capturingPi(): { pi: ExtensionAPI; get: () => { name: string; config: ProviderCfg } } {
  let captured: { name: string; config: ProviderCfg } | undefined;
  const pi = {
    registerProvider: (name: string, config: ProviderCfg) => {
      captured = { name, config };
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    get: () => {
      if (captured === undefined) throw new Error('registerProvider was never called');
      return captured;
    },
  };
}

interface ProviderCfg {
  api?: string;
  streamSimple?: unknown;
  models?: unknown[];
}

/** Fake fetch that streams the given chunk objects back as llama-server SSE. */
function sseFetch(chunks: unknown[]): typeof fetch {
  return (async () => {
    async function* body(): AsyncGenerator<Uint8Array> {
      const enc = new TextEncoder();
      for (const c of chunks) yield enc.encode(`data: ${JSON.stringify(c)}\n\n`);
      yield enc.encode('data: [DONE]\n\n');
    }
    return { ok: true, status: 200, body: body() } as unknown as Response;
  }) as unknown as typeof fetch;
}

function modelWithApi(api: Api): Model<Api> {
  return {
    id: 'gemma-4-e2b-it',
    name: 'Gemma 4 E2B',
    api,
    provider: 'llamacpp',
    baseUrl: 'http://127.0.0.1:8080/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 256,
  };
}

const ctx: Context = {
  systemPrompt: 'test',
  messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
};

async function drain(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

beforeEach(() => {
  // Restore a pristine api-registry: clears any 'llamacpp-stream' left by a prior
  // test and re-registers pi's built-in handlers (incl. openai-completions).
  resetApiProviders();
});

describe('registerLlamaCppProvider — config shape (regression)', () => {
  it('registers streamSimple together with a non-empty api', () => {
    const { pi, get } = capturingPi();
    registerLlamaCppProvider(pi);
    const { name, config } = get();

    expect(name).toBe('llamacpp');
    // The exact bug: streamSimple was registered with NO api.
    expect(typeof config.api).toBe('string');
    expect((config.api ?? '').length).toBeGreaterThan(0);
    expect(config.api).toBe(LLAMACPP_API);
    expect(typeof config.streamSimple).toBe('function');
    // This provider attaches only a handler; models come from models.json.
    expect(config.models).toBeUndefined();
  });

  it('honors an explicit provider name + api override', () => {
    const { pi, get } = capturingPi();
    registerLlamaCppProvider(pi, { providerName: 'llama-local', api: 'custom-api' });
    const { name, config } = get();
    expect(name).toBe('llama-local');
    expect(config.api).toBe('custom-api');
  });
});

describe("pi's real validation (@mariozechner/pi-coding-agent ModelRegistry)", () => {
  it('rejects streamSimple without api (reproduces the original crash)', () => {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    expect(() =>
      // The pre-fix shape: streamSimple, no api.
      registry.registerProvider('llamacpp', {
        streamSimple: sseFetchStream(),
      } as never),
    ).toThrow(/"api" is required when registering streamSimple/);
  });

  it('accepts the fixed config', () => {
    const { pi, get } = capturingPi();
    registerLlamaCppProvider(pi);
    const { name, config } = get();
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    expect(() => registry.registerProvider(name, config as never)).not.toThrow();
  });
});

describe('api-registry resolution (non-bypass / non-hijack)', () => {
  it('resolves OUR streamSimple for a LLAMACPP_API model and leaves openai-completions built-in', async () => {
    const onTimings = vi.fn();
    const deps: LlamaCppStreamDeps = {
      fetchImpl: sseFetch([
        { choices: [{ delta: { content: 'hi' } }] },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          timings: { predicted_per_second: 42 },
        },
      ]),
      onTimings,
    };

    // Register through pi's REAL ModelRegistry (same code path pi uses).
    const { pi, get } = capturingPi();
    registerLlamaCppProvider(pi, { deps });
    const { name, config } = get();
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    registry.registerProvider(name, config as never);

    // Our handler is resolvable under our api...
    const ours = getApiProvider(LLAMACPP_API);
    if (ours === undefined) throw new Error('expected our provider to be resolvable');

    // ...and the built-in openai-completions handler is still present + distinct
    // (we did NOT globally override it).
    const builtin = getApiProvider('openai-completions');
    expect(builtin).toBeDefined();
    expect(builtin).not.toBe(ours);

    // Driving the resolved handler with a matching-api model runs OUR code path:
    // tokens stream and TPS is extracted from llama.cpp timings via onTimings.
    const events = await drain(ours.streamSimple(modelWithApi(LLAMACPP_API), ctx));
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
    expect(onTimings).toHaveBeenCalledWith({ predicted_per_second: 42 });
  });

  it("enforces pi's mismatch guard: our handler refuses a non-LLAMACPP_API model", () => {
    const { pi, get } = capturingPi();
    registerLlamaCppProvider(pi, { deps: { fetchImpl: sseFetch([]) } });
    const { name, config } = get();
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    registry.registerProvider(name, config as never);

    const ours = getApiProvider(LLAMACPP_API);
    if (ours === undefined) throw new Error('expected our provider to be resolvable');
    // wrapStreamSimple throws if model.api !== the registered api — this is the
    // hard proof our handler only ever serves llamacpp-stream models (so a model
    // declaring a different api can never be silently served by us, and vice
    // versa a model must declare llamacpp-stream to reach us).
    expect(() => ours.streamSimple(modelWithApi('openai-completions'), ctx)).toThrow(
      /Mismatched api/,
    );
  });
});

/** A throwaway streamSimple stub for the validation-only test (never invoked). */
function sseFetchStream() {
  return () => {
    throw new Error('not invoked');
  };
}
