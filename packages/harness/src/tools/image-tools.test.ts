import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { type ImageBridge, imageBridgeFromEnv } from './image-bridge-client.js';
import {
  EDIT_IMAGE_TOOL,
  GENERATE_IMAGE_TOOL,
  pdFileUrl,
  registerImageTools,
} from './image-tools.js';

function captureTools() {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (def: ToolDefinition) => {
      tools.set(def.name, def);
    },
  } as unknown as ExtensionAPI;
  const get = (name: string): ToolDefinition => {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`${name} was not registered`);
    return tool;
  };
  return { pi, tools, get };
}

/** A bridge that always succeeds with the given path. */
function okBridge(path: string) {
  const generateImage = vi.fn(async () => ({ ok: true as const, path }));
  const editImage = vi.fn(async () => ({ ok: true as const, path }));
  return { bridge: { generateImage, editImage } as ImageBridge, generateImage, editImage };
}

const ctx = { hasUI: true } as unknown as ExtensionContext;

async function run(tool: ToolDefinition, params: unknown) {
  return (await tool.execute('call-1', params as never, undefined, undefined, ctx)) as {
    content: { type: string; text?: string }[];
    details: { ok: boolean; path?: string; error?: string };
  };
}

describe('pdFileUrl', () => {
  it('builds the app media-scheme URL, encoding each segment', () => {
    expect(pdFileUrl('/Users/j/.pi/desktop/sandbox/gen3d/ab12/prompt-image.png')).toBe(
      'pd-file://f/Users/j/.pi/desktop/sandbox/gen3d/ab12/prompt-image.png',
    );
    // A space must survive as %20, not break the URL.
    expect(pdFileUrl('/tmp/my images/a b.png')).toBe('pd-file://f/tmp/my%20images/a%20b.png');
  });
});

describe('imageBridgeFromEnv', () => {
  it('is null without the desktop bridge env (plain CLI pi)', () => {
    expect(imageBridgeFromEnv({})).toBeNull();
    expect(imageBridgeFromEnv({ PI_DESKTOP_GEN3D_SOCK: '/tmp/s.sock' })).toBeNull();
    expect(imageBridgeFromEnv({ PI_DESKTOP_GEN3D_TOKEN: 't' })).toBeNull();
    expect(
      imageBridgeFromEnv({ PI_DESKTOP_GEN3D_SOCK: '', PI_DESKTOP_GEN3D_TOKEN: '' }),
    ).toBeNull();
  });

  it('is a bridge when both env keys are present', () => {
    const b = imageBridgeFromEnv({
      PI_DESKTOP_GEN3D_SOCK: '/tmp/s.sock',
      PI_DESKTOP_GEN3D_TOKEN: 't',
    });
    expect(b).not.toBeNull();
  });
});

describe('registerImageTools — graceful degradation', () => {
  it('registers NOTHING when there is no bridge', () => {
    const { pi, tools } = captureTools();
    registerImageTools(pi, null);
    expect(tools.size).toBe(0);
  });

  it('registers both tools when a bridge exists', () => {
    const { pi, tools } = captureTools();
    registerImageTools(pi, okBridge('/x.png').bridge);
    expect([...tools.keys()].sort()).toEqual([EDIT_IMAGE_TOOL, GENERATE_IMAGE_TOOL]);
  });
});

describe('generate_image', () => {
  const IMG = '/Users/j/.pi/desktop/sandbox/gen3d/abc/prompt-image.png';

  it('returns the pd-file URL FIRST and the disk path second', async () => {
    const { pi, get } = captureTools();
    const { bridge, generateImage } = okBridge(IMG);
    registerImageTools(pi, bridge);

    const res = await run(get(GENERATE_IMAGE_TOOL), { prompt: '  a red bicycle  ' });

    expect(generateImage).toHaveBeenCalledWith('a red bicycle', undefined);
    const lines = (res.content[0]?.text ?? '').split('\n');
    // Line 1 must be the renderable URL — that is what the chat picks up to
    // draw the image inline.
    expect(lines[0]).toBe(`pd-file://f${IMG}`);
    // Line 2 carries the plain path so the model can pass it to edit_image.
    expect(lines[1]).toContain(IMG);
    expect(res.details).toMatchObject({ ok: true, path: IMG });
  });

  it('never base64s the image into the transcript', async () => {
    const { pi, get } = captureTools();
    registerImageTools(pi, okBridge(IMG).bridge);
    const res = await run(get(GENERATE_IMAGE_TOOL), { prompt: 'x' });
    expect(res.content.every((c) => c.type === 'text')).toBe(true);
    expect(JSON.stringify(res)).not.toContain('base64');
    // The whole result stays tiny — the entire point of the URL.
    expect(JSON.stringify(res).length).toBeLessThan(500);
  });

  it('surfaces the engine reason instead of throwing or hanging', async () => {
    const { pi, get } = captureTools();
    const bridge = {
      generateImage: async () => ({ ok: false as const, error: 'Mage-Flow is not installed yet' }),
      editImage: async () => ({ ok: false as const, error: 'nope' }),
    } as ImageBridge;
    registerImageTools(pi, bridge);

    const res = await run(get(GENERATE_IMAGE_TOOL), { prompt: 'x' });
    expect(res.content[0]?.text).toContain('Mage-Flow is not installed yet');
    expect(res.details).toMatchObject({ ok: false });
  });

  it('rejects an empty prompt without calling the engine', async () => {
    const { pi, get } = captureTools();
    const { bridge, generateImage } = okBridge(IMG);
    registerImageTools(pi, bridge);
    const res = await run(get(GENERATE_IMAGE_TOOL), { prompt: '   ' });
    expect(generateImage).not.toHaveBeenCalled();
    expect(res.details.ok).toBe(false);
  });
});

describe('edit_image', () => {
  const EDITED = '/Users/j/.pi/desktop/sandbox/gen3d/def/edited-image.png';

  it('passes image_path + instruction through and renders the result inline', async () => {
    const { pi, get } = captureTools();
    const { bridge, editImage } = okBridge(EDITED);
    registerImageTools(pi, bridge);

    const res = await run(get(EDIT_IMAGE_TOOL), {
      image_path: '/tmp/source.png',
      instruction: 'make the jacket red',
    });

    expect(editImage).toHaveBeenCalledWith('/tmp/source.png', 'make the jacket red', undefined);
    expect((res.content[0]?.text ?? '').split('\n')[0]).toBe(`pd-file://f${EDITED}`);
    expect(res.details).toMatchObject({ ok: true, path: EDITED });
  });

  it('requires both a path and an instruction', async () => {
    const { pi, get } = captureTools();
    const { bridge, editImage } = okBridge(EDITED);
    registerImageTools(pi, bridge);
    const tool = get(EDIT_IMAGE_TOOL);

    expect((await run(tool, { image_path: '', instruction: 'x' })).details.ok).toBe(false);
    expect((await run(tool, { image_path: '/a.png', instruction: ' ' })).details.ok).toBe(false);
    expect(editImage).not.toHaveBeenCalled();
  });

  it('describes itself as instruction-following, not mask-based', () => {
    const { pi, get } = captureTools();
    registerImageTools(pi, okBridge(EDITED).bridge);
    const desc = get(EDIT_IMAGE_TOOL).description ?? '';
    expect(desc).toContain('make the jacket red');
    expect(desc).toContain('no mask');
  });
});
