import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
  ToolInfo,
} from '@mariozechner/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HARNESS_CONFIG_ENTRY, type StoredEntryLike, wireHarness } from './index.js';

// biome-ignore lint/suspicious/noExplicitAny: event handler shape varies per event in the fake bus.
type AnyHandler = (event: any, ctx: any) => any;

function makeFakePi(toolNames: string[]) {
  const handlers = new Map<string, AnyHandler[]>();
  const entries: StoredEntryLike[] = [];
  let activeTools: string[] = [];
  let command:
    | { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
    | undefined;
  let toolSearch: ToolDefinition | undefined;
  let planTool: ToolDefinition | undefined;

  const pi = {
    on: (event: string, h: AnyHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(h);
      handlers.set(event, list);
    },
    registerTool: (def: ToolDefinition) => {
      if (def.name === 'tool_search') toolSearch = def;
      if (def.name === 'update_plan') planTool = def;
    },
    registerCommand: (
      _name: string,
      opts: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
    ) => {
      command = opts;
    },
    getAllTools: (): ToolInfo[] =>
      [...toolNames, 'tool_search'].map((name) => ({
        name,
        description: `${name} tool`,
        // biome-ignore lint/suspicious/noExplicitAny: stub schema.
        parameters: {} as any,
        sourceInfo: {
          path: `<t:${name}>`,
          source: 'builtin',
          scope: 'temporary',
          origin: 'top-level',
        },
      })),
    getActiveTools: () => activeTools,
    setActiveTools: vi.fn((names: string[]) => {
      activeTools = names;
    }),
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: 'custom', customType, data });
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    entries,
    fire: (event: string, e: unknown, ctx: unknown) =>
      Promise.all((handlers.get(event) ?? []).map((h) => h(e, ctx))),
    getCommand: () => command,
    getToolSearch: () => toolSearch,
    getPlanTool: () => planTool,
    getActiveTools: () => activeTools,
    setActiveTools: pi.setActiveTools as unknown as ReturnType<typeof vi.fn>,
  };
}

function makeCtx(entries: StoredEntryLike[]) {
  const notify = vi.fn();
  const setStatus = vi.fn();
  const ctx = {
    hasUI: true,
    ui: { notify, setStatus, confirm: vi.fn(async () => true) },
    getContextUsage: () => ({ tokens: 100, contextWindow: 8000, percent: 1.25 }),
    sessionManager: { getEntries: () => entries },
  } as unknown as ExtensionContext & ExtensionCommandContext;
  return { ctx, notify, setStatus };
}

describe('wireHarness', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('registers tool_search and the /harness command', () => {
    const f = makeFakePi(['read', 'bash']);
    wireHarness(f.pi);
    expect(f.getToolSearch()?.name).toBe('tool_search');
    expect(f.getCommand()).toBeDefined();
  });

  it('classifies on before_agent_start and calls setActiveTools with the preset', async () => {
    const f = makeFakePi(['read', 'write', 'edit', 'ls', 'find', 'grep', 'bash', 'python_run']);
    wireHarness(f.pi);
    const { ctx } = makeCtx(f.entries);
    await f.fire('session_start', { type: 'session_start', reason: 'startup' }, ctx);
    await f.fire(
      'before_agent_start',
      {
        type: 'before_agent_start',
        prompt: 'Refactor the auth module.',
        systemPrompt: '',
        systemPromptOptions: {},
      },
      ctx,
    );
    expect(f.setActiveTools).toHaveBeenCalled();
    const lastCall = f.setActiveTools.mock.calls.at(-1)?.[0] as string[];
    // coding preset → filesystem + bash + python + tool_search.
    expect(lastCall).toContain('bash');
    expect(lastCall).toContain('python_run');
    expect(lastCall).toContain('tool_search');
  });

  it('emits the classify+title piggyback title over the status channel (turn 1)', async () => {
    const f = makeFakePi(['read', 'write', 'edit', 'ls', 'find', 'grep', 'bash', 'python_run']);
    // A mock CallModel standing in for the utility llama-server: returns the
    // grammar-shaped {title, class} object the piggyback expects.
    const callModel = vi.fn(async () => '{"title":"Auth refactor","class":"coding"}');
    wireHarness(f.pi, { callModel });
    const { ctx, setStatus } = makeCtx(f.entries);
    await f.fire('session_start', { type: 'session_start', reason: 'startup' }, ctx);
    await f.fire(
      'before_agent_start',
      {
        type: 'before_agent_start',
        prompt: 'Refactor the auth module.',
        systemPrompt: '',
        systemPromptOptions: {},
      },
      ctx,
    );
    expect(callModel).toHaveBeenCalled();
    // Dedicated title status key…
    expect(
      setStatus.mock.calls.some((c) => c[0] === 'harness-title' && c[1] === 'Auth refactor'),
    ).toBe(true);
    // …and carried in the structured harness status JSON.
    const last = setStatus.mock.calls.filter((c) => c[0] === 'harness').at(-1)?.[1] as string;
    expect(JSON.parse(last).title).toBe('Auth refactor');
    // The fast heuristic still owns the (unambiguous) class → coding preset.
    const tools = f.setActiveTools.mock.calls.at(-1)?.[0] as string[];
    expect(tools).toContain('python_run');
  });

  it('publishes a status JSON under the "harness" key', async () => {
    const f = makeFakePi(['read']);
    wireHarness(f.pi);
    const { ctx, setStatus } = makeCtx(f.entries);
    await f.fire('session_start', { type: 'session_start', reason: 'startup' }, ctx);
    const statusCall = setStatus.mock.calls.find((c) => c[0] === 'harness');
    expect(statusCall).toBeDefined();
    const status = JSON.parse(statusCall?.[1] as string);
    expect(status).toMatchObject({ mode: 'reviewer', effort: 'medium', preset: 'auto' });
  });

  it('resets the plan on session_start so a new chat does not inherit the old checklist', async () => {
    const f = makeFakePi(['read']);
    wireHarness(f.pi);
    const { ctx, setStatus } = makeCtx(f.entries);
    const harnessStatus = () => {
      const last = setStatus.mock.calls.filter((c) => c[0] === 'harness').at(-1)?.[1] as string;
      return JSON.parse(last);
    };

    await f.fire('session_start', { type: 'session_start', reason: 'startup' }, ctx);
    // The model publishes a checklist in session 1.
    await f
      .getPlanTool()
      ?.execute?.(
        'c',
        { plan: [{ text: 'step one', status: 'in_progress' }] },
        undefined,
        undefined,
        ctx,
      );
    expect(harnessStatus().plan).not.toBeNull();

    // "New chat" → session_start fires again; the republished plan must be empty,
    // not the previous session's leftover checklist.
    setStatus.mockClear();
    await f.fire('session_start', { type: 'session_start', reason: 'startup' }, ctx);
    expect(harnessStatus().plan).toBeNull();
  });

  it('warns via model_select when a small model meets an advanced task', async () => {
    const f = makeFakePi(['read']);
    const handle = wireHarness(f.pi);
    const { ctx, notify } = makeCtx(f.entries);
    await f.fire('session_start', { type: 'session_start', reason: 'startup' }, ctx);
    // Set an advanced active class first.
    handle.applyPreset('3d', ctx);
    await f.fire(
      'model_select',
      { type: 'model_select', model: { id: 'gemma4-e2b', name: 'Gemma4 E2B' }, source: 'set' },
      ctx,
    );
    const warned = notify.mock.calls.some(
      (c) => typeof c[0] === 'string' && c[0].includes('small') && c[1] === 'warning',
    );
    expect(warned).toBe(true);
  });
});

describe('/harness command protocol', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function setup() {
    const f = makeFakePi(['read', 'bash', 'python_run']);
    const handle = wireHarness(f.pi);
    const { ctx, notify } = makeCtx(f.entries);
    await f.fire('session_start', { type: 'session_start', reason: 'startup' }, ctx);
    const run = (args: string) => f.getCommand()?.handler(args, ctx) ?? Promise.resolve();
    return { f, handle, ctx, notify, run };
  }

  it('set-mode changes the permission controller and persists', async () => {
    const { handle, run, f } = await setup();
    await run('set-mode bypass');
    expect(handle.controller.getMode()).toBe('bypass');
    // Persisted via appendEntry → restorable.
    const persisted = f.entries.filter((e) => e.customType === HARNESS_CONFIG_ENTRY);
    expect(persisted.at(-1)?.data).toMatchObject({ mode: 'bypass' });
  });

  it('rejects an unknown mode', async () => {
    const { run, notify, handle } = await setup();
    await run('set-mode yolo');
    expect(handle.controller.getMode()).not.toBe('yolo');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Unknown mode'), 'error');
  });

  it('effort updates config and reports knobs', async () => {
    const { run, handle, notify } = await setup();
    await run('effort max');
    expect(handle.getConfig().effort).toBe('max');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('effort → max'));
  });

  it('preset auto vs fixed', async () => {
    const { run, handle, f } = await setup();
    await run('preset coding');
    expect(handle.getConfig().preset).toBe('coding');
    // fixed preset applies immediately.
    expect(f.setActiveTools).toHaveBeenCalled();
    await run('preset auto');
    expect(handle.getConfig().preset).toBe('auto');
  });

  it('classify is a pure debug helper', async () => {
    const { run, notify } = await setup();
    await run('classify draw an illustration of a fox');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('class: 2d-art'));
  });

  it('status prints and republishes', async () => {
    const { run, notify } = await setup();
    await run('status');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('harness status'));
  });

  it('help on empty/unknown', async () => {
    const { run, notify } = await setup();
    await run('');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Usage: /harness'));
  });
});
