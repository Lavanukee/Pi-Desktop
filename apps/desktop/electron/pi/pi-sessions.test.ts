import type { PiBridgeEvent } from '@pi-desktop/engine';
import { describe, expect, it } from 'vitest';
import { createPiSessions, type SessionBridge, type SessionSender } from './pi-sessions';

class FakeSender implements SessionSender {
  destroyed = false;
  readonly destroyedListeners: Array<() => void> = [];
  readonly goneListeners: Array<(event: unknown, details: { reason: string }) => void> = [];

  constructor(readonly id: number) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }
  once(_event: 'destroyed', listener: () => void): void {
    this.destroyedListeners.push(listener);
  }
  on(
    _event: 'render-process-gone',
    listener: (event: unknown, details: { reason: string }) => void,
  ): void {
    this.goneListeners.push(listener);
  }
  emitDestroyed(): void {
    this.destroyed = true;
    for (const listener of [...this.destroyedListeners]) listener();
  }
  emitRenderProcessGone(reason: string): void {
    for (const listener of [...this.goneListeners]) listener({}, { reason });
  }
}

class FakeBridge implements SessionBridge {
  alive = true;
  disposeCalls = 0;
  readonly spawnPlan = { source: 'env' };
  readonly sent: Array<{ type: string; timeoutMs?: number }> = [];
  /** Ids the engine-side dialog set would consider answerable. */
  readonly answerable = new Set<string>();

  constructor(
    readonly onEvent: (event: PiBridgeEvent) => void,
    readonly pid: number = 4242,
  ) {}

  ready(): Promise<void> {
    return Promise.resolve();
  }
  send(
    cmd: { type: string; [key: string]: unknown },
    opts?: { timeoutMs?: number },
  ): Promise<{ success: boolean; data?: unknown }> {
    this.sent.push({ type: cmd.type, timeoutMs: opts?.timeoutMs });
    return Promise.resolve({ success: true, data: { messages: [], models: [], commands: [] } });
  }
  prompt(): Promise<unknown> {
    return Promise.resolve({});
  }
  steer(): Promise<unknown> {
    return Promise.resolve({});
  }
  abort(): Promise<unknown> {
    return Promise.resolve({});
  }
  bash(): Promise<{
    data: { output: string; exitCode: number; cancelled: boolean; truncated: boolean };
  }> {
    return Promise.resolve({
      data: { output: '', exitCode: 0, cancelled: false, truncated: false },
    });
  }
  respondUi(id: string): boolean {
    return this.answerable.delete(id);
  }
  whenExited(): Promise<void> {
    return Promise.resolve();
  }
  killNow(): void {}
  dispose(): void {
    this.disposeCalls += 1;
    this.alive = false;
  }

  /** Simulates pi exiting on its own (crash / clean exit). */
  exitNow(): void {
    this.alive = false;
  }
  /** Emits a blocking confirm dialog, mirroring the engine's dialog-id add. */
  emitDialog(id: string): void {
    this.answerable.add(id);
    this.onEvent({ type: 'extension_ui_request', id, method: 'confirm', title: 't', message: 'm' });
  }
}

function setup() {
  const created: FakeBridge[] = [];
  const sent: Array<{ senderId: number; event: PiBridgeEvent }> = [];
  const warns: unknown[][] = [];
  const sessions = createPiSessions<FakeSender>({
    createBridge: (_req, onEvent) => {
      const bridge = new FakeBridge(onEvent, 4242 + created.length);
      created.push(bridge);
      return bridge;
    },
    sendEvent: (sender, event) => sent.push({ senderId: sender.id, event }),
    log: { info: () => {}, warn: (...args) => warns.push(args) },
  });
  return { sessions, created, sent, warns };
}

describe('createPiSessions', () => {
  it('spawns one bridge per sender and reuses a live one', async () => {
    const { sessions, created } = setup();
    const sender = new FakeSender(1);

    const first = await sessions.handlers['pi:start'](sender, {});
    expect(first).toEqual({ pid: 4242, alreadyRunning: false });

    const second = await sessions.handlers['pi:start'](sender, {});
    expect(second).toEqual({ pid: 4242, alreadyRunning: true });
    expect(created).toHaveLength(1);

    const other = await sessions.handlers['pi:start'](new FakeSender(2), {});
    expect(other).toEqual({ pid: 4243, alreadyRunning: false });
    expect(sessions.bridges()).toHaveLength(2);
  });

  it('hooks sender lifecycle once per WebContents, not once per pi restart', async () => {
    const { sessions, created } = setup();
    const sender = new FakeSender(1);

    await sessions.handlers['pi:start'](sender, {});
    created[0]?.exitNow();
    await sessions.handlers['pi:start'](sender, {});
    created[1]?.exitNow();
    await sessions.handlers['pi:start'](sender, {});

    expect(created).toHaveLength(3);
    expect(sender.destroyedListeners).toHaveLength(1);
    expect(sender.goneListeners).toHaveLength(1);
    // Each replaced (dead) bridge was explicitly disposed, not just dropped.
    expect(created[0]?.disposeCalls).toBe(1);
    expect(created[1]?.disposeCalls).toBe(1);
    expect(created[2]?.disposeCalls).toBe(0);
  });

  it('disposes the bridge when the WebContents is destroyed', async () => {
    const { sessions, created } = setup();
    const sender = new FakeSender(1);

    await sessions.handlers['pi:start'](sender, {});
    sender.emitDestroyed();

    expect(created[0]?.disposeCalls).toBe(1);
    expect(sessions.bridges()).toHaveLength(0);
  });

  it('keeps the bridge alive across render-process-gone (reload recovery) and logs it', async () => {
    const { sessions, created, warns } = setup();
    const sender = new FakeSender(1);

    await sessions.handlers['pi:start'](sender, {});
    sender.emitRenderProcessGone('oom');

    expect(created[0]?.disposeCalls).toBe(0);
    expect(sessions.bridges()).toHaveLength(1);
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns[0])).toContain('oom');
  });

  it('replays pending blocking dialogs to a re-attaching renderer', async () => {
    const { sessions, created, sent } = setup();
    const sender = new FakeSender(1);
    await sessions.handlers['pi:start'](sender, {});
    const bridge = created[0];
    if (bridge === undefined) throw new Error('bridge not created');

    bridge.emitDialog('dialog-1');
    // Fire-and-forget requests never block pi and must not be replayed.
    bridge.onEvent({
      type: 'extension_ui_request',
      id: 'notify-1',
      method: 'notify',
      message: 'hi',
    });
    expect(sent).toHaveLength(2); // live forwarding still works

    sent.length = 0;
    const restart = await sessions.handlers['pi:start'](sender, {});
    expect(restart).toEqual({ pid: 4242, alreadyRunning: true });
    expect(sent.map(({ event }) => event)).toEqual([
      { type: 'extension_ui_request', id: 'dialog-1', method: 'confirm', title: 't', message: 'm' },
    ]);
  });

  it('stops replaying a dialog once respondUi delivered the answer', async () => {
    const { sessions, created, sent } = setup();
    const sender = new FakeSender(1);
    await sessions.handlers['pi:start'](sender, {});
    created[0]?.emitDialog('dialog-1');

    const delivered = await sessions.handlers['pi:respond-ui'](sender, {
      id: 'dialog-1',
      answer: { confirmed: true },
    });
    expect(delivered).toEqual({ delivered: true });

    sent.length = 0;
    await sessions.handlers['pi:start'](sender, {});
    expect(sent).toHaveLength(0);
  });

  it('keeps a dialog pending when the bridge refuses the answer (unknown id)', async () => {
    const { sessions, created, sent } = setup();
    const sender = new FakeSender(1);
    await sessions.handlers['pi:start'](sender, {});
    created[0]?.emitDialog('dialog-1');

    const delivered = await sessions.handlers['pi:respond-ui'](sender, {
      id: 'other-id',
      answer: { confirmed: true },
    });
    expect(delivered).toEqual({ delivered: false });

    sent.length = 0;
    await sessions.handlers['pi:start'](sender, {});
    expect(sent).toHaveLength(1);
  });

  it('does not forward events to a destroyed WebContents', async () => {
    const { sessions, created, sent } = setup();
    const sender = new FakeSender(1);
    await sessions.handlers['pi:start'](sender, {});

    sent.length = 0;
    sender.destroyed = true;
    created[0]?.onEvent({ type: '_stderr', text: 'noise' });
    expect(sent).toHaveLength(0);
  });

  it('acks pi-not-running instead of throwing when there is no live bridge', async () => {
    const { sessions } = setup();
    const sender = new FakeSender(1);

    expect(await sessions.handlers['pi:prompt'](sender, { message: 'hi' })).toEqual({
      success: false,
      error: 'pi is not running',
    });
    expect(
      await sessions.handlers['pi:respond-ui'](sender, { id: 'x', answer: { cancelled: true } }),
    ).toEqual({ delivered: false });
  });

  it('applies per-channel send timeouts (reads 10s, mutations 30s)', async () => {
    const { sessions, created } = setup();
    const sender = new FakeSender(1);
    await sessions.handlers['pi:start'](sender, {});

    await sessions.handlers['pi:get-state'](sender, undefined);
    await sessions.handlers['pi:get-messages'](sender, undefined);
    await sessions.handlers['pi:get-commands'](sender, undefined);
    await sessions.handlers['pi:get-models'](sender, undefined);
    await sessions.handlers['pi:switch-session'](sender, { sessionPath: '/tmp/s.jsonl' });
    await sessions.handlers['pi:set-model'](sender, { provider: 'llamacpp', modelId: 'm' });

    const bridge = created[0];
    if (bridge === undefined) throw new Error('no bridge');
    const timeoutFor = (type: string) => bridge.sent.find((s) => s.type === type)?.timeoutMs;
    expect(timeoutFor('get_state')).toBe(10_000);
    expect(timeoutFor('get_messages')).toBe(10_000);
    expect(timeoutFor('get_commands')).toBe(10_000);
    expect(timeoutFor('get_available_models')).toBe(30_000);
    expect(timeoutFor('switch_session')).toBe(30_000);
    expect(timeoutFor('set_model')).toBe(30_000);
  });

  it('pi:fork forwards the entryId (mutate timeout) and returns text/cancelled', async () => {
    const { sessions, created } = setup();
    const sender = new FakeSender(1);
    await sessions.handlers['pi:start'](sender, {});
    const bridge = created[0];
    if (bridge === undefined) throw new Error('no bridge');
    // FakeBridge resolves generically; override to return a fork payload.
    bridge.send = (cmd, opts) => {
      bridge.sent.push({ type: cmd.type, timeoutMs: opts?.timeoutMs });
      return Promise.resolve({ success: true, data: { text: 'orig text', cancelled: false } });
    };

    const res = await sessions.handlers['pi:fork'](sender, { entryId: 'abc12345' });
    expect(res).toEqual({ success: true, text: 'orig text', cancelled: false });
    const forkSend = bridge.sent.find((s) => s.type === 'fork');
    expect(forkSend?.timeoutMs).toBe(30_000);
  });

  it('pi:get-fork-messages returns the fork list (read timeout)', async () => {
    const { sessions, created } = setup();
    const sender = new FakeSender(1);
    await sessions.handlers['pi:start'](sender, {});
    const bridge = created[0];
    if (bridge === undefined) throw new Error('no bridge');
    bridge.send = (cmd, opts) => {
      bridge.sent.push({ type: cmd.type, timeoutMs: opts?.timeoutMs });
      return Promise.resolve({
        success: true,
        data: { messages: [{ entryId: 'e1', text: 'hi' }] },
      });
    };

    const res = await sessions.handlers['pi:get-fork-messages'](sender, undefined);
    expect(res).toEqual({ success: true, messages: [{ entryId: 'e1', text: 'hi' }] });
    expect(bridge.sent.find((s) => s.type === 'get_fork_messages')?.timeoutMs).toBe(10_000);
  });

  it('pi:fork acks pi-not-running when nothing is live', async () => {
    const { sessions } = setup();
    expect(await sessions.handlers['pi:fork'](new FakeSender(9), { entryId: 'x' })).toEqual({
      success: false,
      error: 'pi is not running',
    });
    expect(await sessions.handlers['pi:get-fork-messages'](new FakeSender(9), undefined)).toEqual({
      success: false,
      messages: [],
      error: 'pi is not running',
    });
  });

  it('pi:new-session starts a fresh session in the running pi without respawning', async () => {
    const { sessions, created } = setup();
    const sender = new FakeSender(1);
    await sessions.handlers['pi:start'](sender, {});
    const bridge = created[0];
    if (bridge === undefined) throw new Error('no bridge');
    bridge.send = (cmd, opts) => {
      bridge.sent.push({ type: cmd.type, timeoutMs: opts?.timeoutMs });
      return Promise.resolve({ success: true, data: { cancelled: false } });
    };

    const res = await sessions.handlers['pi:new-session'](sender, undefined);

    expect(res).toEqual({ success: true, cancelled: false });
    // Same live bridge — new_session never disposes/respawns (the whole point).
    expect(created).toHaveLength(1);
    expect(bridge.disposeCalls).toBe(0);
    expect(bridge.alive).toBe(true);
    expect(bridge.sent.find((s) => s.type === 'new_session')?.timeoutMs).toBe(30_000);
  });

  it('pi:new-session acks pi-not-running when nothing is live', async () => {
    const { sessions } = setup();
    expect(await sessions.handlers['pi:new-session'](new FakeSender(9), undefined)).toEqual({
      success: false,
      error: 'pi is not running',
    });
  });

  it('pi:restart disposes the live bridge and respawns a fresh one', async () => {
    const { sessions, created } = setup();
    const sender = new FakeSender(1);
    await sessions.handlers['pi:start'](sender, { cwd: '/work' });

    const result = await sessions.handlers['pi:restart'](sender, undefined);

    expect(result).toEqual({ success: true, pid: 4243 });
    expect(created).toHaveLength(2);
    // Old bridge was disposed (idempotent dispose may run more than once).
    expect(created[0]?.disposeCalls).toBeGreaterThanOrEqual(1);
    expect(created[0]?.alive).toBe(false);
    // Fresh bridge is the live one; the old one is gone.
    expect(sessions.bridges().map((b) => b.pid)).toEqual([4243]);
  });

  it('respawns extension-free when pi exits at startup with extensions loaded', async () => {
    const created: Array<{ bridge: FakeBridge; extensionsDisabled: boolean }> = [];
    const sessions = createPiSessions<FakeSender>({
      createBridge: (_req, onEvent, opts) => {
        const bridge = new FakeBridge(onEvent, 5000 + created.length);
        // Simulate a broken extension crashing pi at startup.
        if (opts?.extensionsDisabled !== true) bridge.alive = false;
        created.push({ bridge, extensionsDisabled: opts?.extensionsDisabled === true });
        return bridge;
      },
      sendEvent: () => {},
      log: { info: () => {}, warn: () => {} },
    });

    const result = await sessions.handlers['pi:start'](new FakeSender(1), {});

    expect(created).toHaveLength(2); // crashed spawn + extension-free retry
    expect(created[0]?.extensionsDisabled).toBe(false);
    expect(created[1]?.extensionsDisabled).toBe(true);
    expect(result.alreadyRunning).toBe(false);
    expect(sessions.bridges().some((b) => b.alive)).toBe(true);
  });

  it('pi:restart acks pi-not-running when nothing is live', async () => {
    const { sessions } = setup();
    expect(await sessions.handlers['pi:restart'](new FakeSender(9), undefined)).toEqual({
      success: false,
      error: 'pi is not running',
    });
  });

  it('disposeAll disposes every registered bridge (quit path)', async () => {
    const { sessions, created } = setup();
    await sessions.handlers['pi:start'](new FakeSender(1), {});
    await sessions.handlers['pi:start'](new FakeSender(2), {});

    sessions.disposeAll();

    expect(created.map((bridge) => bridge.disposeCalls)).toEqual([1, 1]);
    expect(sessions.bridges()).toHaveLength(0);
  });
});
