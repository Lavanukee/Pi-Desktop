import type { ExtensionAPI, ToolDefinition, ToolInfo } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { registerToolSearch, searchTools, type ToolLike } from './tool-search.js';

const TOOLS: ToolLike[] = [
  {
    name: 'read',
    description: 'Read file contents from disk',
    parameters: { properties: { path: {} } },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL over HTTP and return readable text',
    parameters: { properties: { url: {} } },
  },
  {
    name: 'web_search',
    description: 'Search the web for a query',
    parameters: { properties: { query: {} } },
  },
  {
    name: 'python_run',
    description: 'Execute a Python snippet',
    parameters: { properties: { code: {} } },
  },
  {
    name: 'image_generate',
    description: 'Generate an image from a text prompt',
    parameters: { properties: { prompt: {} } },
  },
];

describe('searchTools — matching', () => {
  it('ranks a name hit above a description-only hit', () => {
    const r = searchTools(TOOLS, 'search');
    expect(r[0]?.name).toBe('web_search');
  });

  it('matches on description tokens', () => {
    const r = searchTools(TOOLS, 'http url');
    expect(r[0]?.name).toBe('web_fetch');
  });

  it('matches on parameter names', () => {
    const r = searchTools(TOOLS, 'path');
    expect(r.map((m) => m.name)).toContain('read');
  });

  it('returns nothing for an empty or non-matching query', () => {
    expect(searchTools(TOOLS, '')).toEqual([]);
    expect(searchTools(TOOLS, 'quantum teleportation')).toEqual([]);
  });

  it('respects the limit', () => {
    const r = searchTools(TOOLS, 'a e', { limit: 2 });
    expect(r.length).toBeLessThanOrEqual(2);
  });

  it('tags currently-active tools', () => {
    const r = searchTools(TOOLS, 'python', { activeToolNames: ['python_run'] });
    expect(r[0]).toMatchObject({ name: 'python_run', active: true });
  });
});

/** Build a minimal fake ExtensionAPI capturing the tool registration + active set. */
function fakePi(available: ToolLike[], initialActive: string[]) {
  let active = [...initialActive];
  let registered: ToolDefinition | undefined;
  const setActiveTools = vi.fn((names: string[]) => {
    active = names;
  });
  const pi = {
    registerTool: (def: ToolDefinition) => {
      registered = def;
    },
    getAllTools: (): ToolInfo[] =>
      available.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        parameters: (t.parameters ?? {}) as unknown as ToolInfo['parameters'],
        sourceInfo: {
          path: `<test:${t.name}>`,
          source: 'builtin',
          scope: 'temporary',
          origin: 'top-level',
        },
      })) as ToolInfo[],
    getActiveTools: () => active,
    setActiveTools,
  } as unknown as ExtensionAPI;
  return {
    pi,
    setActiveTools,
    getRegistered: () => registered,
    getActive: () => active,
  };
}

describe('registerToolSearch — activation wiring', () => {
  it('registers a tool_search tool', () => {
    const f = fakePi(TOOLS, ['read']);
    registerToolSearch(f.pi);
    expect(f.getRegistered()?.name).toBe('tool_search');
  });

  it('activate:true unions matched tools into the active set', async () => {
    const f = fakePi(TOOLS, ['read']);
    const onActivate = vi.fn();
    registerToolSearch(f.pi, { onActivate });
    const def = f.getRegistered();
    expect(def).toBeDefined();
    if (!def) return;

    const params = { query: 'search the web', activate: true } as unknown as Parameters<
      typeof def.execute
    >[1];
    const ctx = {} as unknown as Parameters<typeof def.execute>[4];
    const result = await def.execute('call-1', params, undefined, undefined, ctx);

    expect(f.setActiveTools).toHaveBeenCalledOnce();
    expect(f.getActive()).toContain('read'); // preserved
    expect(f.getActive()).toContain('web_search'); // added
    expect(onActivate).toHaveBeenCalledWith(expect.arrayContaining(['web_search']));
    expect(result.content[0]).toMatchObject({ type: 'text' });
  });

  it('activate:false only lists, never mutates the active set', async () => {
    const f = fakePi(TOOLS, ['read']);
    registerToolSearch(f.pi);
    const def = f.getRegistered();
    expect(def).toBeDefined();
    if (!def) return;
    const params = { query: 'python', activate: false } as unknown as Parameters<
      typeof def.execute
    >[1];
    const ctx = {} as unknown as Parameters<typeof def.execute>[4];
    await def.execute('call-2', params, undefined, undefined, ctx);
    expect(f.setActiveTools).not.toHaveBeenCalled();
  });
});
