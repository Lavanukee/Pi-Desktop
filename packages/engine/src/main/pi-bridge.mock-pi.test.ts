/**
 * Bridge lifecycle against the REAL mock-pi spawned as a child process
 * (plain node). This doubles as mock-pi's own test: it proves the fixture
 * player speaks protocol-correct JSONL that the production framing,
 * correlation, and dialog paths consume end to end.
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_PI_DIR } from '../renderer/test-helpers/fixtures';
import type { PiBridgeEvent, RpcExtensionUIRequest } from '../types/rpc';
import { PiBridge } from './pi-bridge';

const MOCK_PI = path.join(MOCK_PI_DIR, 'mock-pi.mjs');
const fixture = (name: string) => path.join(MOCK_PI_DIR, 'fixtures', `${name}.json`);

interface Harness {
  bridge: PiBridge;
  events: PiBridgeEvent[];
  waitFor<T extends PiBridgeEvent>(pred: (e: PiBridgeEvent) => e is T, ms?: number): Promise<T>;
  waitForType(type: PiBridgeEvent['type'], ms?: number): Promise<PiBridgeEvent>;
}

const harnesses: Harness[] = [];

function launch(fixtureName: string): Harness {
  const events: PiBridgeEvent[] = [];
  const waiters: Array<{
    pred: (e: PiBridgeEvent) => boolean;
    resolve: (e: PiBridgeEvent) => void;
  }> = [];
  const bridge = new PiBridge(
    {
      cwd: process.cwd(),
      // Exercise the bundled-style spawn plan against plain node: command =
      // execPath (node running vitest), argsPrefix = [mock-pi.mjs].
      appRoot: MOCK_PI_DIR,
      execPath: process.execPath,
      isElectron: false,
      locateBundledCli: () => MOCK_PI,
      env: { MOCK_PI_FIXTURE: fixture(fixtureName) },
    },
    (e) => {
      events.push(e);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter?.pred(e)) {
          waiters.splice(i, 1);
          waiter.resolve(e);
        }
      }
    },
  );
  const waitForPred = (
    pred: (e: PiBridgeEvent) => boolean,
    ms = 10_000,
  ): Promise<PiBridgeEvent> => {
    const existing = events.find(pred);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for event (saw ${events.length})`)),
        ms,
      );
      waiters.push({
        pred,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  };
  const harness: Harness = {
    bridge,
    events,
    waitFor: (pred, ms) => waitForPred(pred, ms) as Promise<never>,
    waitForType: (type, ms) => waitForPred((e) => e.type === type, ms),
  };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    h.bridge.dispose();
    if (h.bridge.alive) {
      await h.waitForType('_bridge_exit', 5000).catch(() => undefined);
    }
  }
});

describe('PiBridge against real mock-pi (simple-chat)', () => {
  it('boots, streams a full text turn, and shuts down via the kill ladder', async () => {
    const h = launch('simple-chat');
    await h.bridge.ready();

    // The readiness probe's get_state response arrived and carries state.
    const state = await h.bridge.getState();
    expect(state.data.sessionId).toBe('mock-session-simple-chat');
    expect(state.data.model?.id).toBe('qwen3.6-27b');

    const models = await h.bridge.getAvailableModels();
    expect(models.data.models.map((m) => m.id)).toEqual(['qwen3.6-27b', 'gemma4-e4b']);

    const promptResponse = await h.bridge.prompt('hello');
    expect(promptResponse.success).toBe(true);

    await h.waitForType('agent_end');
    const deltas = h.events
      .filter((e) => e.type === 'message_update')
      .map((e) => (e.type === 'message_update' ? e.assistantMessageEvent : undefined))
      .filter((ev) => ev?.type === 'text_delta')
      .map((ev) => (ev !== undefined && 'delta' in ev ? ev.delta : ''));
    expect(deltas.join('')).toBe('Hello from mock-pi — streaming works.');

    h.bridge.dispose();
    const exit = await h.waitForType('_bridge_exit');
    expect(exit.type).toBe('_bridge_exit');
    expect(h.bridge.alive).toBe(false);
  });

  it('surfaces the real Unknown-command failure when type is missing (the rename quirk)', async () => {
    const h = launch('simple-chat');
    await h.bridge.ready();
    // A client that forgot the command→type rename produces exactly this.
    await expect(h.bridge.send({ notAType: true })).rejects.toThrow('Unknown command: undefined');
    // …while the `command` spelling is transparently renamed and succeeds.
    await expect(h.bridge.send({ command: 'get_state' })).resolves.toMatchObject({
      success: true,
    });
  });

  it('rejects unscripted prompts with the fixture error', async () => {
    const h = launch('edge-cases');
    await h.bridge.ready();
    await expect(h.bridge.prompt('no scenario matches this')).rejects.toThrow('no scripted turn');
  });
});

describe('PiBridge against real mock-pi (edge-cases)', () => {
  it('blocks on a confirm dialog until respondUi answers, then finishes the run', async () => {
    const h = launch('edge-cases');
    await h.bridge.ready();

    await h.bridge.prompt('please confirm the cleanup');
    const request = (await h.waitFor(
      (e): e is RpcExtensionUIRequest =>
        e.type === 'extension_ui_request' && e.method === 'confirm',
    )) as RpcExtensionUIRequest;
    expect(request.id).toBe('ui-confirm-1');

    // Playback is blocked on the dialog: the post-confirm notify must not
    // have arrived yet.
    const notifySeen = h.events.some(
      (e) => e.type === 'extension_ui_request' && e.method === 'notify',
    );
    expect(notifySeen).toBe(false);

    expect(h.bridge.respondUi(request.id, { confirmed: true })).toBe(true);
    await h.waitForType('agent_end');

    const notifies = h.events.filter(
      (e): e is RpcExtensionUIRequest & { method: 'notify' } =>
        e.type === 'extension_ui_request' && e.method === 'notify',
    );
    expect(notifies.map((n) => n.notifyType)).toEqual(['info', 'error']);
  });

  it('streams huge U+2028-bearing blocks intact through real pipes', async () => {
    const h = launch('edge-cases');
    await h.bridge.ready();
    await h.bridge.prompt('think hard');
    await h.waitForType('agent_end', 15_000);

    const thinkingDeltas = h.events
      .filter((e) => e.type === 'message_update')
      .map((e) => (e.type === 'message_update' ? e.assistantMessageEvent : undefined))
      .filter((ev) => ev?.type === 'thinking_delta')
      .map((ev) => (ev !== undefined && 'delta' in ev ? ev.delta : ''));
    expect(thinkingDeltas.join('')).toContain('line A\u2028line B\u2029line C');

    const textDeltas = h.events
      .filter((e) => e.type === 'message_update')
      .map((e) => (e.type === 'message_update' ? e.assistantMessageEvent : undefined))
      .filter((ev) => ev?.type === 'text_delta')
      .map((ev) => (ev !== undefined && 'delta' in ev ? String(ev.delta) : ''));
    const huge = textDeltas.find((d) => d.length > 10_000);
    expect(huge).toBeDefined();
    expect(huge).toBe('All work and no play makes pi a dull agent. '.repeat(400));
  });
});

describe('PiBridge against real mock-pi (parallel-tools + status-stream)', () => {
  it('carries two interleaved tool-call streams through real pipes', async () => {
    const h = launch('parallel-tools');
    await h.bridge.ready();
    await h.bridge.prompt('run the parallel writes');
    await h.waitForType('agent_end', 15_000);

    const starts = h.events
      .filter((e) => e.type === 'message_update')
      .map((e) => (e.type === 'message_update' ? e.assistantMessageEvent : undefined))
      .filter((ev) => ev?.type === 'toolcall_start');
    expect(starts).toHaveLength(2);
    // Deltas alternate between the two content indexes (interleaved streams).
    const deltaIndexes = h.events
      .filter((e) => e.type === 'message_update')
      .map((e) => (e.type === 'message_update' ? e.assistantMessageEvent : undefined))
      .filter((ev) => ev?.type === 'toolcall_delta')
      .map((ev) => (ev !== undefined && 'contentIndex' in ev ? ev.contentIndex : -1));
    expect(deltaIndexes.slice(0, 4)).toEqual([0, 1, 0, 1]);
    const ends = h.events.filter((e) => e.type === 'tool_execution_end');
    expect(ends.map((e) => (e.type === 'tool_execution_end' ? e.toolCallId : ''))).toEqual([
      'call_par_b',
      'call_par_a',
    ]);
  });

  it('carries the status/lifecycle event vocabulary end to end', async () => {
    const h = launch('status-stream');
    await h.bridge.ready();
    await h.bridge.prompt('show me the status events');
    await h.waitForType('agent_end', 15_000);

    const types = h.events.map((e) => e.type);
    for (const expected of [
      'queue_update',
      'compaction_start',
      'compaction_end',
      'auto_retry_start',
      'auto_retry_end',
    ]) {
      expect(types).toContain(expected);
    }
    // model_change / thinking_level_change / session_changed are legacy-shaped
    // events the router handles defensively; the bridge forwards them as-is.
    const raw = h.events as Array<{ type: string }>;
    expect(raw.some((e) => e.type === 'model_change')).toBe(true);
    expect(raw.some((e) => e.type === 'thinking_level_change')).toBe(true);
    expect(raw.some((e) => e.type === 'session_changed')).toBe(true);
    const select = h.events.find((e) => e.type === 'extension_ui_request' && e.method === 'select');
    expect(select).toMatchObject({ id: 'ui-select-1', options: ['claude', 'codex'] });
  });
});

describe('PiBridge spawn failure via the real spawn path', () => {
  it('settles alive=false, rejects sends, and emits _bridge_error on ENOENT', async () => {
    const events: PiBridgeEvent[] = [];
    const bridge = new PiBridge(
      {
        cwd: process.cwd(),
        binPath: path.join(MOCK_PI_DIR, 'definitely-not-a-real-binary'),
        readyProbe: false,
        env: {},
      },
      (e) => events.push(e),
    );
    const inflight = bridge.send({ type: 'get_state' });
    // Real spawn failures surface asynchronously with no 'exit' event; only
    // the terminal-settlement path can resolve this.
    await bridge.whenExited();
    expect(bridge.alive).toBe(false);
    await expect(inflight).rejects.toThrow();
    await expect(bridge.send({ type: 'abort' })).rejects.toThrow('pi process has exited');
    expect(events.some((e) => e.type === '_bridge_error')).toBe(true);
  });
});

describe('PiBridge spawning mock-pi via PI_BIN (shebang exec)', () => {
  it('resolves PI_BIN from the environment and completes a prompt', async () => {
    const events: PiBridgeEvent[] = [];
    const bridge = new PiBridge(
      {
        cwd: process.cwd(),
        env: { PI_BIN: MOCK_PI, MOCK_PI_FIXTURE: fixture('simple-chat'), PATH: process.env.PATH },
      },
      (e) => events.push(e),
    );
    try {
      expect(bridge.spawnPlan.source).toBe('env');
      await bridge.ready();
      const res = await bridge.prompt('hello');
      expect(res.success).toBe(true);
    } finally {
      bridge.dispose();
    }
  });
});
