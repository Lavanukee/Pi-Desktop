import type { ExtensionAPI, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import type { GenBridge } from './gen-bridge-client.ts';
import type { GenBridgeMethod } from './gen-contract.ts';
import { GENERATE_IMAGE_TOOL, parseSize, registerGenTools } from './tools.ts';

type Handler = (params: Record<string, unknown> | undefined) => unknown;

class FakeBridge implements GenBridge {
  readonly calls: Array<{ method: GenBridgeMethod; params?: Record<string, unknown> }> = [];
  readonly handlers = new Map<GenBridgeMethod, Handler>();
  on(method: GenBridgeMethod, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }
  async request<T>(method: GenBridgeMethod, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (handler === undefined) throw new Error(`no fake handler for ${method}`);
    return handler(params) as T;
  }
}

function collectTools(
  bridge: GenBridge | null,
  readImage?: (p: string) => Promise<Buffer>,
): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (def: ToolDefinition) => tools.set(def.name, def),
  } as unknown as ExtensionAPI;
  registerGenTools(pi, { bridge, readImage });
  return tools;
}

async function run(tools: Map<string, ToolDefinition>, params: Record<string, unknown>) {
  const tool = tools.get(GENERATE_IMAGE_TOOL);
  if (tool === undefined) throw new Error('missing generate_image tool');
  // biome-ignore lint/suspicious/noExplicitAny: minimal ctx stub for tests.
  return tool.execute('call-1', params as any, undefined, undefined, {} as any);
}

// biome-ignore lint/suspicious/noExplicitAny: reach into the untyped details bag.
const details = (r: { details: unknown }) => r.details as any;

describe('parseSize', () => {
  it('parses WxH and rounds to a multiple of 16', () => {
    expect(parseSize('512x512')).toEqual({ width: 512, height: 512 });
    expect(parseSize('257x257')).toEqual({ width: 256, height: 256 });
  });
  it('clamps to the supported range', () => {
    expect(parseSize('16x16')).toEqual({ width: 256, height: 256 });
    expect(parseSize('4000x4000')).toEqual({ width: 1536, height: 1536 });
  });
  it('defaults to 1024x1024 on garbage / missing', () => {
    expect(parseSize(undefined)).toEqual({ width: 1024, height: 1024 });
    expect(parseSize('big')).toEqual({ width: 1024, height: 1024 });
  });
});

describe('generate_image tool', () => {
  it('registers the tool and advertises the catalog models', () => {
    const tools = collectTools(new FakeBridge());
    const tool = tools.get(GENERATE_IMAGE_TOOL);
    expect(tool?.label).toBe('Generate: Image');
    expect(tool?.description).toContain('z-image-turbo');
  });

  it('reports unavailable when no bridge (loaded outside Pi Desktop)', async () => {
    const tools = collectTools(null);
    const res = await run(tools, { prompt: 'a cat' });
    expect(details(res).ok).toBe(false);
    expect(details(res).error).toContain('bridge unavailable');
  });

  it('rejects an unknown model against the catalog', async () => {
    const tools = collectTools(new FakeBridge());
    const res = await run(tools, { prompt: 'a cat', model: 'stable-diffusion-xl' });
    expect(details(res).ok).toBe(false);
    expect(details(res).error).toContain('unknown image model');
  });

  it('enqueues via the bridge and returns paths + the model footnote + image blocks', async () => {
    const bridge = new FakeBridge().on('generate', (params) => ({
      jobId: 'job-9',
      outputs: [
        {
          outputPath: '/out/a.png',
          modality: 'image',
          model: params?.model,
          seed: 1,
          width: 512,
          height: 512,
        },
        {
          outputPath: '/out/b.png',
          modality: 'image',
          model: params?.model,
          seed: 2,
          width: 512,
          height: 512,
        },
      ],
    }));
    const reads: string[] = [];
    const readImage = async (p: string): Promise<Buffer> => {
      reads.push(p);
      return Buffer.from(`png:${p}`);
    };
    const tools = collectTools(bridge, readImage);

    const res = await run(tools, {
      prompt: 'a fox',
      model: 'z-image-turbo',
      size: '512x512',
      n: 2,
    });

    // The generate RPC carried the normalised params.
    expect(bridge.calls[0]?.method).toBe('generate');
    expect(bridge.calls[0]?.params).toMatchObject({
      prompt: 'a fox',
      model: 'z-image-turbo',
      n: 2,
    });

    expect(details(res).ok).toBe(true);
    expect(details(res).jobId).toBe('job-9');
    // Text lists both paths + the FOOTNOTE with the model + license.
    const text = (res.content.find((c) => c.type === 'text') as { text: string }).text;
    expect(text).toContain('/out/a.png');
    expect(text).toContain('/out/b.png');
    expect(text).toContain('Model: Z-Image Turbo (z-image-turbo, apache-2.0)');
    // Both images attached as image blocks.
    const images = res.content.filter((c) => c.type === 'image');
    expect(images).toHaveLength(2);
    expect(reads).toEqual(['/out/a.png', '/out/b.png']);
  });

  it('defaults to the catalog default model when none is given', async () => {
    const bridge = new FakeBridge().on('generate', (params) => ({
      jobId: 'job-1',
      outputs: [{ outputPath: '/out/x.png', modality: 'image', model: params?.model, seed: 1 }],
    }));
    const tools = collectTools(bridge, async () => Buffer.from('x'));
    await run(tools, { prompt: 'a tree' });
    expect(bridge.calls[0]?.params?.model).toBe('flux2-klein-4b');
  });

  it('surfaces a generator error as a structured (never-thrown) result', async () => {
    const bridge = new FakeBridge().on('generate', () => {
      throw new Error('metal out of memory');
    });
    const tools = collectTools(bridge, async () => Buffer.from('x'));
    const res = await run(tools, { prompt: 'a cat', model: 'z-image-turbo' });
    expect(details(res).ok).toBe(false);
    expect(details(res).error).toContain('metal out of memory');
  });
});
