/**
 * Produce / merge the pi `models.json` provider block for a running llama-server.
 *
 * Mirrors the shape pi reads from `~/.pi/agent/models.json`:
 *   providers.<name> = { baseUrl, api:"llamacpp-stream", apiKey, compat, models[] }
 *
 * `api` is "llamacpp-stream" (not "openai-completions") so these models bind to
 * @pi-desktop/provider-llamacpp's custom streamSimple handler (tool-call repair +
 * TPS) instead of pi's built-in openai-completions path. The provider extension
 * registers that api id; the two MUST agree or models silently use the built-in.
 * The build is a pure function; `writeModelsJson` read-merge-writes so it never
 * clobbers other providers already in the file. Electron-free.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CatalogModel } from './catalog.js';

export interface ModelsJsonModel {
  readonly id: string;
  readonly name: string;
  readonly input: ('text' | 'image')[];
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface ModelsJsonCompat {
  readonly supportsDeveloperRole: boolean;
  readonly supportsReasoningEffort: boolean;
  readonly supportsUsageInStreaming: boolean;
}

export interface ProviderBlock {
  readonly baseUrl: string;
  /** Binds to @pi-desktop/provider-llamacpp's streamSimple handler (repair + TPS). */
  readonly api: 'llamacpp-stream';
  readonly apiKey: string;
  readonly compat: ModelsJsonCompat;
  readonly models: ModelsJsonModel[];
}

export interface ModelsJson {
  providers: Record<string, ProviderBlock>;
}

export interface BuildProviderBlockOptions {
  /** OpenAI-compatible base URL, e.g. "http://127.0.0.1:8080/v1". */
  readonly baseUrl: string;
  /** Model id the llama-server advertises (defaults to the catalog id). */
  readonly servedModelId?: string;
  /** Cap on output tokens (defaults to contextWindow - 4096, min 1024). */
  readonly maxTokens?: number;
}

/**
 * Build a single provider block for one catalog model served by a llama-server.
 * `apiKey: "none"` matches the live example — llama-server needs no auth but pi
 * requires the field present.
 */
export function buildProviderBlock(
  model: CatalogModel,
  opts: BuildProviderBlockOptions,
): ProviderBlock {
  const maxTokens = opts.maxTokens ?? Math.max(1024, model.contextWindow - 4096);
  return {
    baseUrl: opts.baseUrl,
    api: 'llamacpp-stream',
    apiKey: 'none',
    compat: {
      // llama-server is not OpenAI: it wants "system" not "developer", exposes
      // no reasoning_effort, and (by default) omits usage from stream chunks.
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
    },
    models: [
      {
        id: opts.servedModelId ?? model.id,
        name: model.displayName,
        input: [...model.input],
        contextWindow: model.contextWindow,
        maxTokens,
      },
    ],
  };
}

/** Pure merge: set `providers[name]` on a copy of `existing`. */
export function mergeProviderBlock(
  existing: ModelsJson | undefined,
  name: string,
  block: ProviderBlock,
): ModelsJson {
  const providers = { ...(existing?.providers ?? {}) };
  providers[name] = block;
  return { providers };
}

/** Parse existing models.json, tolerating a missing/corrupt file. */
async function readModelsJson(path: string): Promise<ModelsJson | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ModelsJson>;
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.providers === 'object') {
      return { providers: parsed.providers ?? {} };
    }
    return { providers: {} };
  } catch {
    return undefined;
  }
}

/** Read-merge-write the provider block into `path`, preserving other providers. */
export async function writeModelsJson(
  path: string,
  name: string,
  block: ProviderBlock,
): Promise<ModelsJson> {
  const existing = await readModelsJson(path);
  const merged = mergeProviderBlock(existing, name, block);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}
