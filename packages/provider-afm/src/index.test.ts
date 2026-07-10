/**
 * Registration/regression tests for the AFM provider extension, driving pi's
 * REAL machinery (@mariozechner/pi-coding-agent ModelRegistry + pi-ai
 * api-registry) — not a re-implementation — so they lock in the exact contract:
 *
 *   1. Registering `streamSimple` WITHOUT an `api` throws pi's validation error.
 *   2. Our fixed config (with {@link AFM_API}) passes pi's validation.
 *   3. A models.json-style provider block with a dummy `baseUrl` ('afm://local'),
 *      `apiKey`, and one `afm-stream` model passes pi's "baseUrl required when
 *      defining models" validation (the shape the desktop app writes).
 *   4. pi's api-registry resolves OUR streamSimple for a model whose
 *      `api === AFM_API`, streams via a fake streamAfm, leaves the built-in
 *      openai-completions handler untouched, and hard-binds via the mismatch guard.
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
import type { AfmRequest, AfmStreamResult, StreamAfmOptions } from '@pi-desktop/afm';
import { beforeEach, describe, expect, it } from 'vitest';
import { AFM_API, registerAfmProvider } from './index.js';
import type { StreamAfmFn } from './stream.js';

interface ProviderCfg {
  api?: string;
  baseUrl?: string;
  apiKey?: string;
  streamSimple?: unknown;
  models?: unknown[];
}

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

function modelWithApi(api: Api): Model<Api> {
  return {
    id: 'apple-on-device',
    name: 'Apple Intelligence',
    api,
    provider: 'afm',
    baseUrl: 'afm://local',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  };
}

const ctx: Context = { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] };

const fakeStreamAfm: StreamAfmFn = async (_request: AfmRequest, options?: StreamAfmOptions) => {
  options?.onDelta?.('hi');
  const result: AfmStreamResult = { text: 'hi', usage: { inputTokens: 1, outputTokens: 1 } };
  return result;
};

async function drain(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

beforeEach(() => {
  resetApiProviders();
});

describe('registerAfmProvider — config shape', () => {
  it('registers streamSimple together with a non-empty api', () => {
    const { pi, get } = capturingPi();
    registerAfmProvider(pi);
    const { name, config } = get();
    expect(name).toBe('afm');
    expect(config.api).toBe(AFM_API);
    expect(typeof config.streamSimple).toBe('function');
    // Models come from models.json; the extension attaches only the handler.
    expect(config.models).toBeUndefined();
  });

  it('honors an explicit provider name + api override', () => {
    const { pi, get } = capturingPi();
    registerAfmProvider(pi, { providerName: 'apple', api: 'custom-api' });
    const { name, config } = get();
    expect(name).toBe('apple');
    expect(config.api).toBe('custom-api');
  });
});

describe("pi's real ModelRegistry validation", () => {
  it('rejects streamSimple without api', () => {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    expect(() => registry.registerProvider('afm', { streamSimple: () => {} } as never)).toThrow(
      /"api" is required when registering streamSimple/,
    );
  });

  it('accepts the extension config (handler only, no models)', () => {
    const { pi, get } = capturingPi();
    registerAfmProvider(pi, { deps: { streamAfmImpl: fakeStreamAfm } });
    const { name, config } = get();
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    expect(() => registry.registerProvider(name, config as never)).not.toThrow();
  });

  it('accepts the models.json block shape with a dummy baseUrl', () => {
    // The exact provider block the desktop app writes into models.json: a model
    // definition needs a non-empty baseUrl + apiKey, so we use the dummy
    // 'afm://local' (our streamSimple owns generation and never dials it).
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    expect(() =>
      registry.registerProvider('afm', {
        baseUrl: 'afm://local',
        api: AFM_API,
        apiKey: 'none',
        models: [
          {
            id: 'apple-on-device',
            name: 'Apple Intelligence',
            contextWindow: 4096,
            maxTokens: 1024,
          },
        ],
      } as never),
    ).not.toThrow();
    // Missing baseUrl reproduces pi's "required when defining models" error.
    expect(() =>
      registry.registerProvider('afm2', {
        api: AFM_API,
        apiKey: 'none',
        models: [{ id: 'apple-on-device', name: 'Apple Intelligence' }],
      } as never),
    ).toThrow(/"baseUrl" is required when defining models/);
  });
});

describe('api-registry resolution (non-bypass / non-hijack)', () => {
  it('resolves OUR streamSimple for an AFM_API model and leaves openai-completions built-in', async () => {
    const { pi, get } = capturingPi();
    registerAfmProvider(pi, { deps: { streamAfmImpl: fakeStreamAfm } });
    const { name, config } = get();
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    registry.registerProvider(name, config as never);

    const ours = getApiProvider(AFM_API);
    if (ours === undefined) throw new Error('expected our provider to be resolvable');
    const builtin = getApiProvider('openai-completions');
    expect(builtin).toBeDefined();
    expect(builtin).not.toBe(ours);

    const events = await drain(ours.streamSimple(modelWithApi(AFM_API), ctx));
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });

  it("enforces pi's mismatch guard: our handler refuses a non-AFM_API model", () => {
    const { pi, get } = capturingPi();
    registerAfmProvider(pi, { deps: { streamAfmImpl: fakeStreamAfm } });
    const { name, config } = get();
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    registry.registerProvider(name, config as never);

    const ours = getApiProvider(AFM_API);
    if (ours === undefined) throw new Error('expected our provider to be resolvable');
    expect(() => ours.streamSimple(modelWithApi('openai-completions'), ctx)).toThrow(
      /Mismatched api/,
    );
  });
});
