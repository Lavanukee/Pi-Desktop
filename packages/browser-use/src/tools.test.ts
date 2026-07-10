import type { ExtensionAPI, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import type { BrowserBridge } from './bridge-client.js';
import type { BrowserAgentMethod } from './protocol.js';
import { registerBrowserUseTools } from './tools.js';

type Handler = (params: Record<string, unknown> | undefined) => unknown;

/** A programmable fake bridge that records every call. */
class FakeBridge implements BrowserBridge {
  readonly calls: Array<{ method: BrowserAgentMethod; params?: Record<string, unknown> }> = [];
  readonly handlers = new Map<BrowserAgentMethod, Handler>();

  on(method: BrowserAgentMethod, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  async request<T>(method: BrowserAgentMethod, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (handler === undefined) throw new Error(`no fake handler for ${method}`);
    return handler(params) as T;
  }

  countOf(method: BrowserAgentMethod): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

const SNAP = (canvasHeavy = false) => ({
  ok: true,
  elements: [],
  summary: {
    title: 'T',
    url: 'https://x.test/',
    headings: [],
    landmarks: [],
    scrollY: 0,
    maxScrollY: 0,
    atBottom: true,
    elementCount: 0,
    truncated: false,
    canvasHeavy,
  },
});

/** Collect tools registered against a fake ExtensionAPI. */
function collectTools(bridge: BrowserBridge | null): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (def: ToolDefinition) => tools.set(def.name, def),
  } as unknown as ExtensionAPI;
  registerBrowserUseTools(pi, { bridge });
  return tools;
}

async function run(
  tools: Map<string, ToolDefinition>,
  name: string,
  params: Record<string, unknown>,
) {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  // biome-ignore lint/suspicious/noExplicitAny: minimal ctx stub for tests.
  return tool.execute('call-1', params as any, undefined, undefined, {} as any);
}

// biome-ignore lint/suspicious/noExplicitAny: reach into the untyped details bag.
const details = (r: { details: unknown }) => r.details as any;

describe('registerBrowserUseTools', () => {
  it('registers the full tool set', () => {
    const tools = collectTools(new FakeBridge());
    expect([...tools.keys()].sort()).toEqual(
      [
        'browser_back',
        'browser_click',
        'browser_forward',
        'browser_key',
        'browser_navigate',
        'browser_read',
        'browser_scroll',
        'browser_snapshot',
        'browser_type',
        'browser_wait',
      ].sort(),
    );
  });

  it('reports a clear error (never throws) when the bridge is unavailable', async () => {
    const tools = collectTools(null);
    const r = await run(tools, 'browser_navigate', { url: 'https://x.test' });
    expect(details(r).ok).toBe(false);
    expect(details(r).error).toContain('bridge unavailable');
  });

  it('navigate drives the bridge navigate method', async () => {
    const bridge = new FakeBridge().on('navigate', () => ({
      tabId: 't',
      url: 'https://x.test/',
      title: 'Hello',
    }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'browser_navigate', { url: 'x.test' });
    expect(details(r).ok).toBe(true);
    expect(bridge.calls[0]).toMatchObject({ method: 'navigate', params: { url: 'x.test' } });
  });

  it('snapshot evaluates the perception script and returns a formatted list', async () => {
    const bridge = new FakeBridge().on('evaluate', () => SNAP());
    const tools = collectTools(bridge);
    const r = await run(tools, 'browser_snapshot', {});
    expect(details(r).ok).toBe(true);
    const evalCall = bridge.calls.find((c) => c.method === 'evaluate');
    expect(String(evalCall?.params?.script)).toContain('collectSnapshot');
  });

  it('snapshot attaches a screenshot image when requested', async () => {
    const bridge = new FakeBridge()
      .on('evaluate', () => SNAP())
      .on('screenshot', () => ({ dataUrl: 'data:image/png;base64,AAAA' }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'browser_snapshot', { screenshot: true });
    const img = r.content.find((c) => c.type === 'image');
    expect(img).toMatchObject({ type: 'image', mimeType: 'image/png', data: 'AAAA' });
  });

  it('click prefers a DOM click, and re-snapshots + retries once on a stale index', async () => {
    let clickCalls = 0;
    const bridge = new FakeBridge()
      .on('evaluate', () => SNAP())
      .on('clickElement', () => ({ found: ++clickCalls > 1 })); // first stale, then found
    const tools = collectTools(bridge);
    const r = await run(tools, 'browser_click', { index: 3 });
    expect(details(r).ok).toBe(true);
    expect(bridge.countOf('clickElement')).toBe(2);
    // A fresh snapshot happened between the two click attempts.
    expect(bridge.countOf('evaluate')).toBe(1);
    expect(bridge.calls[0]?.params).toMatchObject({ index: 3, mode: 'dom' });
  });

  it('click falls back to coordinate mode on a canvas/WebGL-heavy page', async () => {
    const bridge = new FakeBridge()
      .on('evaluate', () => SNAP(true)) // canvasHeavy
      .on('clickElement', () => ({ found: true }));
    const tools = collectTools(bridge);
    // Take a snapshot first so the tool learns the page is canvas-heavy.
    await run(tools, 'browser_snapshot', {});
    await run(tools, 'browser_click', { index: 1 });
    const clickCall = bridge.calls.find((c) => c.method === 'clickElement');
    expect(clickCall?.params?.mode).toBe('coord');
  });

  it('click accepts explicit x,y coordinates', async () => {
    const bridge = new FakeBridge().on('click', () => ({ ok: true }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'browser_click', { x: 12, y: 34 });
    expect(details(r).ok).toBe(true);
    expect(bridge.calls[0]).toMatchObject({ method: 'click', params: { x: 12, y: 34 } });
  });

  it('type re-snapshots + retries once, then succeeds', async () => {
    let typeCalls = 0;
    const bridge = new FakeBridge()
      .on('evaluate', () => SNAP())
      .on('type', () => ({ found: ++typeCalls > 1 }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'browser_type', { index: 2, text: 'hi', submit: true });
    expect(details(r).ok).toBe(true);
    expect(bridge.countOf('type')).toBe(2);
    expect(bridge.calls[0]?.params).toMatchObject({ index: 2, text: 'hi', submit: true });
  });

  it('scroll and read route through evaluate', async () => {
    const bridge = new FakeBridge().on('evaluate', (params) => {
      const script = String(params?.script);
      if (script.includes('scrollImpl')) return { scrollY: 100, maxScrollY: 900, atBottom: false };
      return { ok: true, title: 'Doc', text: 'body text', truncated: false };
    });
    const tools = collectTools(bridge);
    const scrolled = await run(tools, 'browser_scroll', { direction: 'down' });
    expect(details(scrolled).ok).toBe(true);
    const read = await run(tools, 'browser_read', {});
    expect(read.content[0]?.type).toBe('text');
    expect(JSON.stringify(read.content)).toContain('body text');
  });

  it('surfaces a bridge failure as a structured error instead of throwing', async () => {
    const bridge = new FakeBridge().on('navigate', () => {
      throw new Error('boom');
    });
    const tools = collectTools(bridge);
    const r = await run(tools, 'browser_navigate', { url: 'x.test' });
    expect(details(r).ok).toBe(false);
    expect(details(r).error).toBe('boom');
  });
});
