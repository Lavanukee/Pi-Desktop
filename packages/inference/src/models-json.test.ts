import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GEMMA4_E2B, getCatalogModel } from './catalog.js';
import {
  buildMlxProviderBlock,
  buildProviderBlock,
  type ModelsJson,
  mergeProviderBlock,
  writeModelsJson,
} from './models-json.js';

describe('models-json', () => {
  const path = join(tmpdir(), `pi-models-${Math.random().toString(36).slice(2)}.json`);
  afterEach(async () => {
    await rm(path, { force: true });
  });

  it('builds a llamacpp-stream provider block matching pi shape', () => {
    const block = buildProviderBlock(GEMMA4_E2B, { baseUrl: 'http://127.0.0.1:8080/v1' });
    expect(block.api).toBe('llamacpp-stream');
    expect(block.apiKey).toBe('none');
    expect(block.baseUrl).toBe('http://127.0.0.1:8080/v1');
    expect(block.compat.supportsDeveloperRole).toBe(false);
    expect(block.models).toHaveLength(1);
    expect(block.models[0]?.id).toBe('gemma-4-e2b-it');
    expect(block.models[0]?.contextWindow).toBe(32_768);
    expect(block.models[0]?.maxTokens).toBeGreaterThan(0);
  });

  it('merges into existing providers without clobbering them', () => {
    const existing: ModelsJson = {
      providers: {
        anthropic: {
          baseUrl: 'https://api.anthropic.com',
          api: 'llamacpp-stream',
          apiKey: 'x',
          compat: {
            supportsDeveloperRole: true,
            supportsReasoningEffort: true,
            supportsUsageInStreaming: true,
          },
          models: [],
        },
      },
    };
    const block = buildProviderBlock(GEMMA4_E2B, { baseUrl: 'http://127.0.0.1:8080/v1' });
    const merged = mergeProviderBlock(existing, 'llamacpp', block);
    expect(Object.keys(merged.providers).sort()).toEqual(['anthropic', 'llamacpp']);
    // Original object is not mutated.
    expect(existing.providers.llamacpp).toBeUndefined();
  });

  it('builds an mlx-stream provider block with usage-in-streaming ON', () => {
    const mlx = getCatalogModel('mlx-qwen3.5-4b-4bit');
    expect(mlx).toBeDefined();
    const block = buildMlxProviderBlock(mlx as NonNullable<typeof mlx>, {
      baseUrl: 'http://127.0.0.1:8181/v1',
      servedModelId: 'mlx-community/Qwen3.5-4B-MLX-4bit',
    });
    expect(block.api).toBe('mlx-stream');
    // MLX emits usage in streaming (client-side TPS depends on it).
    expect(block.compat.supportsUsageInStreaming).toBe(true);
    expect(block.models[0]?.id).toBe('mlx-community/Qwen3.5-4B-MLX-4bit');
  });

  it('writes and re-reads, preserving other providers', async () => {
    const block = buildProviderBlock(GEMMA4_E2B, {
      baseUrl: 'http://127.0.0.1:8080/v1',
      servedModelId: 'served-id',
    });
    await writeModelsJson(path, 'llamacpp', block);
    await writeModelsJson(path, 'other', block);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as ModelsJson;
    expect(Object.keys(parsed.providers).sort()).toEqual(['llamacpp', 'other']);
    expect(parsed.providers.llamacpp?.models[0]?.id).toBe('served-id');
  });
});
