import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { MacBridge } from './bridge-client.js';
import { createMacConsentGate, type MacConsentGate } from './permissions.js';
import type { MacAgentMethod } from './protocol.js';
import { registerMacComputerUseTools } from './tools.js';

type Handler = (params: Record<string, unknown> | undefined) => unknown;

/** A programmable fake bridge that records every call (the "mock helper"). */
class FakeBridge implements MacBridge {
  readonly calls: Array<{ method: MacAgentMethod; params?: Record<string, unknown> }> = [];
  readonly handlers = new Map<MacAgentMethod, Handler>();

  on(method: MacAgentMethod, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  async request<T>(method: MacAgentMethod, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (handler === undefined) throw new Error(`no fake handler for ${method}`);
    return handler(params) as T;
  }

  countOf(method: MacAgentMethod): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

const SNAP = (elements: unknown[] = [], pid = 4242) => ({
  app: 'TextEdit',
  pid,
  window: 'Untitled',
  windowId: 99,
  elements,
  summary: { app: 'TextEdit', window: 'Untitled', elementCount: elements.length, truncated: false },
});

/** ctx stub whose confirm returns yes (so the consent flow can be exercised). */
function ctxStub(hasUI = true, confirmResult = true): ExtensionContext {
  return {
    hasUI,
    ui: { confirm: vi.fn(async () => confirmResult) },
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub.
  } as any as ExtensionContext;
}

function collectTools(
  bridge: MacBridge | null,
  consent: MacConsentGate = createMacConsentGate({ preConsented: true }),
): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (def: ToolDefinition) => tools.set(def.name, def),
  } as unknown as ExtensionAPI;
  registerMacComputerUseTools(pi, { bridge, consent });
  return tools;
}

async function run(
  tools: Map<string, ToolDefinition>,
  name: string,
  params: Record<string, unknown>,
  ctx: ExtensionContext = ctxStub(),
) {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  // biome-ignore lint/suspicious/noExplicitAny: minimal execute args for tests.
  return tool.execute('call-1', params as any, undefined, undefined, ctx);
}

// biome-ignore lint/suspicious/noExplicitAny: reach into the untyped details bag.
const details = (r: { details: unknown }) => r.details as any;

describe('registerMacComputerUseTools', () => {
  it('registers the full tool set', () => {
    const tools = collectTools(new FakeBridge());
    expect([...tools.keys()].sort()).toEqual(
      ['mac_click', 'mac_key', 'mac_launch', 'mac_scroll', 'mac_snapshot', 'mac_type'].sort(),
    );
  });

  it('reports a clear error (never throws) when the bridge is unavailable', async () => {
    const tools = collectTools(null);
    const r = await run(tools, 'mac_snapshot', {});
    expect(details(r).ok).toBe(false);
    expect(details(r).error).toContain('bridge unavailable');
  });

  it('snapshot formats the indexed element list and passes app/cap', async () => {
    const bridge = new FakeBridge().on('snapshot', () =>
      SNAP([
        {
          index: 1,
          role: 'AXTextArea',
          name: 'text entry area',
          bbox: { x: 1, y: 2, w: 3, h: 4 },
          editable: true,
        },
      ]),
    );
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_snapshot', { app: 'TextEdit' });
    expect(details(r).ok).toBe(true);
    expect(String(r.content[0]?.type === 'text' ? r.content[0].text : '')).toContain(
      '[1] AXTextArea',
    );
    expect(bridge.calls[0]).toMatchObject({
      method: 'snapshot',
      params: { app: 'TextEdit', cap: 60 },
    });
  });

  it('snapshot attaches a screenshot image when the helper returns base64', async () => {
    const bridge = new FakeBridge().on('snapshot', () => ({
      ...SNAP(),
      screenshot: { path: '/tmp/x.png', base64: 'AAAA', mimeType: 'image/png' },
    }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_snapshot', { screenshot: true });
    const img = r.content.find((c) => c.type === 'image');
    expect(img).toMatchObject({ type: 'image', mimeType: 'image/png', data: 'AAAA' });
  });

  it('click by index re-snapshots + retries once on a stale index', async () => {
    let clicks = 0;
    const bridge = new FakeBridge()
      .on('snapshot', () => SNAP())
      .on('click', () => ({ found: ++clicks > 1 })); // first stale, then found
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_click', { index: 3 });
    expect(details(r).ok).toBe(true);
    expect(bridge.countOf('click')).toBe(2);
    expect(bridge.countOf('snapshot')).toBe(1); // one re-snapshot between attempts
    expect(bridge.calls[0]).toMatchObject({ method: 'click', params: { index: 3 } });
  });

  it('click accepts explicit x,y coordinates', async () => {
    const bridge = new FakeBridge().on('click', () => ({ ok: true }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_click', { x: 12, y: 34 });
    expect(details(r).ok).toBe(true);
    expect(bridge.calls[0]).toMatchObject({ method: 'click', params: { x: 12, y: 34 } });
  });

  it('type by index passes index+text; focused type omits index', async () => {
    const bridge = new FakeBridge().on('type', () => ({ found: true }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_type', { index: 1, text: 'hello from Pi' });
    expect(bridge.calls[0]).toMatchObject({
      method: 'type',
      params: { index: 1, text: 'hello from Pi' },
    });
    await run(tools, 'mac_type', { text: 'more' });
    expect(bridge.calls[1]).toMatchObject({ method: 'type', params: { text: 'more' } });
  });

  it('refuses index-less typing after a snapshot (never blast keystrokes at the user’s app)', async () => {
    const bridge = new FakeBridge()
      .on('snapshot', () => SNAP([], 555))
      .on('type', () => ({ found: true }));
    const tools = collectTools(bridge);
    // Before any snapshot: focused typing is allowed (genuine frontmost use).
    await run(tools, 'mac_type', { text: 'ok before snapshot' });
    expect(bridge.countOf('type')).toBe(1);
    // After snapshotting a target app: index-less typing is refused (would hit
    // the user's frontmost app via foreground keystrokes).
    await run(tools, 'mac_snapshot', { app: 'Maps' });
    const r = await run(tools, 'mac_type', { text: 'San Francisco to Palo Alto', submit: true });
    expect(details(r).ok).toBe(false);
    expect(details(r).error).toContain('index');
    expect(bridge.countOf('type')).toBe(1); // never reached the bridge again
  });

  // --- background/foreground flag (AX-action path) ---------------------------

  it('surfaces the background flag + mode when the helper sets a value via AX', async () => {
    const bridge = new FakeBridge().on('type', () => ({
      found: true,
      mode: 'setValue',
      background: true,
    }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_type', { index: 1, text: 'hi' });
    expect(details(r).ok).toBe(true);
    expect(details(r).background).toBe(true);
    expect(details(r).mode).toBe('setValue');
    const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
    expect(String(text)).toContain('background via setValue');
  });

  it('marks a click as foreground when the helper falls back to a coordinate click', async () => {
    const bridge = new FakeBridge().on('click', () => ({
      found: true,
      mode: 'coord',
      background: false,
    }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_click', { index: 1 });
    expect(details(r).background).toBe(false);
    const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
    expect(String(text)).toContain('foreground');
  });

  it('type forwards submit:true so the helper can commit a search field', async () => {
    const bridge = new FakeBridge().on('type', () => ({
      found: true,
      mode: 'setValue+confirm',
      background: true,
      submitted: true,
    }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_type', { index: 1, text: 'san francisco', submit: true });
    expect(bridge.calls[0]).toMatchObject({
      method: 'type',
      params: { index: 1, text: 'san francisco', submit: true },
    });
    const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
    expect(String(text)).toContain('Submitted');
  });

  // --- per-pid concurrency namespacing --------------------------------------

  it('stamps the snapshotted pid onto later click/type (concurrency-safe indices)', async () => {
    const bridge = new FakeBridge()
      .on('snapshot', () => SNAP([], 7777))
      .on('click', () => ({ found: true, mode: 'AXPress', background: true }))
      .on('type', () => ({ found: true, mode: 'setValue', background: true }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', { app: 'TextEdit' });
    await run(tools, 'mac_click', { index: 2 });
    await run(tools, 'mac_type', { index: 3, text: 'x' });
    const click = bridge.calls.find((c) => c.method === 'click');
    const type = bridge.calls.find((c) => c.method === 'type');
    expect(click?.params).toMatchObject({ index: 2, pid: 7777 });
    expect(type?.params).toMatchObject({ index: 3, pid: 7777 });
  });

  it('launch opens in the background by default and foregrounds on request', async () => {
    const bridge = new FakeBridge().on('launch', () => ({ ok: true, app: 'Maps' }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_launch', { app: 'Maps' });
    await run(tools, 'mac_launch', { app: 'Maps', foreground: true });
    // (each launch also attempts its immediate snapshot — filter to launches)
    const launches = bridge.calls.filter((c) => c.method === 'launch');
    expect(launches[0]).toMatchObject({ method: 'launch', params: { background: true } });
    expect(launches[1]).toMatchObject({ method: 'launch', params: { background: false } });
  });

  it('key forwards the combo', async () => {
    const bridge = new FakeBridge().on('key', () => ({ ok: true }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_key', { combo: 'cmd+s' });
    expect(details(r).ok).toBe(true);
    expect(bridge.calls[0]).toMatchObject({ method: 'key', params: { combo: 'cmd+s' } });
  });

  it('launch focuses/launches the named app', async () => {
    const bridge = new FakeBridge().on('launch', () => ({ ok: true, app: 'TextEdit' }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_launch', { app: 'TextEdit' });
    expect(details(r).ok).toBe(true);
    expect(bridge.calls[0]).toMatchObject({ method: 'launch', params: { app: 'TextEdit' } });
  });

  it('surfaces a bridge failure as a structured error instead of throwing', async () => {
    const bridge = new FakeBridge().on('key', () => {
      throw new Error('boom');
    });
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_key', { combo: 'cmd+s' });
    expect(details(r).ok).toBe(false);
    expect(details(r).error).toBe('boom');
  });

  // --- consent gating -------------------------------------------------------

  it('the first action asks for consent, then acts; a decline blocks without acting', async () => {
    const bridge = new FakeBridge().on('key', () => ({ ok: true }));
    // Fresh (not pre-consented) gate; ctx confirm returns NO.
    const declineGate = createMacConsentGate();
    const tools = collectTools(bridge, declineGate);
    const declined = await run(tools, 'mac_key', { combo: 'cmd+s' }, ctxStub(true, false));
    expect(details(declined).ok).toBe(false);
    expect(bridge.countOf('key')).toBe(0); // never reached the bridge

    // A fresh gate that says YES: acts, and remembers so the next call skips the prompt.
    const yesGate = createMacConsentGate();
    const tools2 = collectTools(bridge, yesGate);
    const ctx = ctxStub(true, true);
    await run(tools2, 'mac_key', { combo: 'cmd+s' }, ctx);
    await run(tools2, 'mac_key', { combo: 'cmd+z' }, ctx);
    expect(bridge.countOf('key')).toBe(2);
    expect((ctx.ui.confirm as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('refuses a denylisted target (mac_launch Pi Desktop) even when consented', async () => {
    const bridge = new FakeBridge().on('launch', () => ({ ok: true }));
    const tools = collectTools(bridge); // pre-consented
    const r = await run(tools, 'mac_launch', { app: 'Pi Desktop' });
    expect(details(r).ok).toBe(false);
    expect(details(r).error).toContain('denylist');
    expect(bridge.countOf('launch')).toBe(0);
  });

  // --- the controlled-app loop (snapshot-after-open contract) ----------------

  const LAUNCH_ACK = {
    ok: true,
    app: 'TextEdit',
    pid: 4242,
    bounds: { ok: true, pid: 4242, x: 10, y: 20, w: 800, h: 600, windowId: 99 },
  };

  it('launch returns a fresh snapshot AND a window screenshot in the SAME tool result', async () => {
    const bridge = new FakeBridge()
      .on('launch', () => LAUNCH_ACK)
      .on('snapshot', () => ({
        ...SNAP([
          {
            index: 1,
            role: 'AXTextArea',
            name: 'text entry area',
            bbox: { x: 1, y: 2, w: 3, h: 4 },
            editable: true,
          },
        ]),
        screenshot: { path: '/tmp/win.png', base64: 'IMGB64', mimeType: 'image/png' },
      }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_launch', { app: 'TextEdit' });

    // The immediate snapshot targeted the launched pid, with a screenshot.
    const snapCall = bridge.calls.find((c) => c.method === 'snapshot');
    expect(snapCall?.params).toMatchObject({ pid: 4242, screenshot: true });

    // The ONE result carries: launch note + controlled-app statement + indexed
    // elements (text) + the window screenshot (image).
    const text = String(r.content[0]?.type === 'text' ? r.content[0].text : '');
    expect(text).toContain('did NOT take focus');
    expect(text).toContain('controlling "TextEdit"');
    expect(text).toContain('[1] AXTextArea');
    const img = r.content.find((c) => c.type === 'image');
    expect(img).toMatchObject({ type: 'image', data: 'IMGB64', mimeType: 'image/png' });

    expect(details(r)).toMatchObject({
      action: 'launch',
      ok: true,
      app: 'TextEdit',
      pid: 4242,
      background: true,
      controlled: true,
      snapshot: true,
      screenshot: true,
    });
  });

  it('after launch, EVERY act stamps the controlled pid (unambiguous routing)', async () => {
    const bridge = new FakeBridge()
      .on('launch', () => LAUNCH_ACK)
      .on('snapshot', () => SNAP([], 4242))
      .on('click', () => ({ found: true, mode: 'AXPress', background: true }))
      .on('key', () => ({ ok: true, background: true }))
      .on('scroll', () => ({ ok: true, background: true }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_launch', { app: 'TextEdit' });
    await run(tools, 'mac_click', { index: 2 });
    await run(tools, 'mac_click', { x: 100, y: 200 }); // coordinate click too
    await run(tools, 'mac_key', { combo: 'cmd+s' });
    await run(tools, 'mac_scroll', { direction: 'down' });
    const acts = bridge.calls.filter((c) => c.method !== 'launch' && c.method !== 'snapshot');
    expect(acts).toHaveLength(4);
    for (const act of acts) expect(act.params).toMatchObject({ pid: 4242 });
  });

  it('mac_scroll surfaces the helper-verified ladder ack (mode + honest no-movement)', async () => {
    const bridge = new FakeBridge()
      .on('launch', () => LAUNCH_ACK)
      .on('snapshot', () => SNAP([], 4242))
      .on('scroll', (params) =>
        params?.direction === 'down'
          ? { ok: true, background: true, mode: 'gestureToPid', moved: true }
          : { ok: true, background: true, mode: 'exhausted', moved: false },
      );
    const tools = collectTools(bridge);
    await run(tools, 'mac_launch', { app: 'TextEdit' });

    const moved = await run(tools, 'mac_scroll', { direction: 'down' });
    expect(details(moved)).toMatchObject({ ok: true, mode: 'gestureToPid', moved: true });
    const movedText = String(moved.content[0]?.type === 'text' ? moved.content[0].text : '');
    expect(movedText).toContain('Scrolled down');

    const stuck = await run(tools, 'mac_scroll', { direction: 'up' });
    expect(details(stuck)).toMatchObject({ ok: true, mode: 'exhausted', moved: false });
    const stuckText = String(stuck.content[0]?.type === 'text' ? stuck.content[0].text : '');
    expect(stuckText).toContain('NO effect');
  });

  it('a default (app-less) snapshot targets the CONTROLLED app, not frontmost', async () => {
    const bridge = new FakeBridge()
      .on('launch', () => LAUNCH_ACK)
      .on('snapshot', () => SNAP([], 4242));
    const tools = collectTools(bridge);
    await run(tools, 'mac_launch', { app: 'TextEdit' });
    await run(tools, 'mac_snapshot', {});
    const second = bridge.calls.filter((c) => c.method === 'snapshot')[1];
    expect(second?.params).toMatchObject({ pid: 4242 });
    expect(second?.params?.app).toBeUndefined();
  });

  it('launch degrades to text-only (still ok) when the post-open snapshot fails', async () => {
    const bridge = new FakeBridge().on('launch', () => LAUNCH_ACK); // no snapshot handler
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_launch', { app: 'TextEdit' });
    expect(details(r).ok).toBe(true);
    const text = String(r.content[0]?.type === 'text' ? r.content[0].text : '');
    expect(text).toContain('snapshot after launch failed');
    expect(r.content.find((c) => c.type === 'image')).toBeUndefined();
  });

  it('a failed launch surfaces the bridge error as a structured refusal', async () => {
    const bridge = new FakeBridge().on('launch', () => ({
      ok: false,
      app: 'NopeApp',
      error: 'no window appeared for "NopeApp"',
    }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_launch', { app: 'NopeApp' });
    expect(details(r).ok).toBe(false);
    expect(details(r).error).toContain('no window appeared');
    expect(bridge.countOf('snapshot')).toBe(0); // no phantom snapshot attempt
  });
});
