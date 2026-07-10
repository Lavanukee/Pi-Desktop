import { describe, expect, it, vi } from 'vitest';
import {
  createIpcClient,
  createIpcEventHub,
  createIpcEventSender,
  IPC_EVENT_CHANNEL,
  type IpcEventEnvelope,
  registerIpcHandler,
  registerIpcHandlers,
} from './ipc';

type TestInvokeMap = {
  'math:add': { request: { a: number; b: number }; response: number };
  'app:get-name': { request: undefined; response: string };
};

type TestEventMap = {
  'app:boot': { sentAt: number };
  'session:token': string;
};

describe('createIpcClient', () => {
  it('forwards channel and request to invoke and returns the response', async () => {
    const invoke = vi.fn().mockResolvedValue(3);
    const client = createIpcClient<TestInvokeMap>({ invoke });

    const sum = await client.invoke('math:add', { a: 1, b: 2 });

    expect(sum).toBe(3);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('math:add', { a: 1, b: 2 });
  });
});

function createFakeIpcMain() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handlers,
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) {
      handlers.set(channel, listener);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
  };
}

describe('registerIpcHandler', () => {
  it('registers a single handler and disposes it', async () => {
    const ipc = createFakeIpcMain();
    const dispose = registerIpcHandler<TestInvokeMap, 'math:add'>(
      ipc,
      'math:add',
      ({ a, b }) => a + b,
    );

    expect(await ipc.handlers.get('math:add')?.({}, { a: 2, b: 3 })).toBe(5);

    dispose();
    expect(ipc.handlers.size).toBe(0);
  });

  it('applies the allowSender gate', () => {
    const ipc = createFakeIpcMain();
    registerIpcHandler<TestInvokeMap, 'math:add'>(ipc, 'math:add', ({ a, b }) => a + b, {
      allowSender: () => false,
    });

    expect(() => ipc.handlers.get('math:add')?.({}, { a: 2, b: 3 })).toThrow(/untrusted sender/);
  });
});

describe('registerIpcHandlers', () => {
  it('registers every channel in the map and disposes all of them', async () => {
    const ipc = createFakeIpcMain();
    const dispose = registerIpcHandlers<TestInvokeMap>(ipc, {
      'math:add': ({ a, b }) => a + b,
      'app:get-name': () => 'pi-desktop',
    });

    expect(ipc.handlers.size).toBe(2);
    expect(await ipc.handlers.get('math:add')?.({}, { a: 4, b: 5 })).toBe(9);
    expect(await ipc.handlers.get('app:get-name')?.({}, undefined)).toBe('pi-desktop');

    dispose();
    expect(ipc.handlers.size).toBe(0);
  });

  it('rejects an invoke without running the handler when allowSender returns false', () => {
    const ipc = createFakeIpcMain();
    const handler = vi.fn(({ a, b }: { a: number; b: number }) => a + b);
    const untrustedEvent = { sender: 'evil' };
    registerIpcHandlers<TestInvokeMap>(
      ipc,
      { 'math:add': handler, 'app:get-name': () => 'pi-desktop' },
      { allowSender: (event) => event !== untrustedEvent },
    );

    expect(() => ipc.handlers.get('math:add')?.(untrustedEvent, { a: 1, b: 2 })).toThrow(
      /untrusted sender/,
    );
    expect(handler).not.toHaveBeenCalled();

    expect(ipc.handlers.get('math:add')?.({ sender: 'window' }, { a: 1, b: 2 })).toBe(3);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('passes every event through when no allowSender gate is given', () => {
    const ipc = createFakeIpcMain();
    registerIpcHandlers<TestInvokeMap>(ipc, {
      'math:add': ({ a, b }) => a + b,
      'app:get-name': () => 'pi-desktop',
    });

    expect(ipc.handlers.get('math:add')?.({ sender: 'anything' }, { a: 1, b: 2 })).toBe(3);
  });
});

describe('createIpcEventSender', () => {
  it('wraps events into envelopes on the shared wire channel', () => {
    const send = vi.fn();
    const sender = createIpcEventSender<TestEventMap>();

    sender.send({ send }, 'app:boot', { sentAt: 42 });

    expect(send).toHaveBeenCalledExactlyOnceWith(IPC_EVENT_CHANNEL, {
      channel: 'app:boot',
      payload: { sentAt: 42 },
    } satisfies IpcEventEnvelope);
  });
});

describe('createIpcEventHub pre-mount buffer', () => {
  it('buffers events before the first subscription and flushes them in order', () => {
    const hub = createIpcEventHub<TestEventMap>();
    hub.dispatch({ channel: 'session:token', payload: 'a' });
    hub.dispatch({ channel: 'session:token', payload: 'b' });

    const received: string[] = [];
    hub.subscribe('session:token', (payload) => received.push(payload));

    expect(received).toEqual(['a', 'b']);
  });

  it('delivers live events after the flush', () => {
    const hub = createIpcEventHub<TestEventMap>();
    hub.dispatch({ channel: 'session:token', payload: 'buffered' });

    const received: string[] = [];
    hub.subscribe('session:token', (payload) => received.push(payload));
    hub.dispatch({ channel: 'session:token', payload: 'live' });

    expect(received).toEqual(['buffered', 'live']);
  });

  it('buffers per channel independently', () => {
    const hub = createIpcEventHub<TestEventMap>();
    hub.dispatch({ channel: 'app:boot', payload: { sentAt: 1 } });
    hub.dispatch({ channel: 'session:token', payload: 'x' });

    const boots: Array<{ sentAt: number }> = [];
    hub.subscribe('app:boot', (payload) => boots.push(payload));

    expect(boots).toEqual([{ sentAt: 1 }]);

    const tokens: string[] = [];
    hub.subscribe('session:token', (payload) => tokens.push(payload));
    expect(tokens).toEqual(['x']);
  });

  it('does not replay the buffer to later subscribers', () => {
    const hub = createIpcEventHub<TestEventMap>();
    hub.dispatch({ channel: 'session:token', payload: 'early' });

    hub.subscribe('session:token', () => {});
    const late: string[] = [];
    hub.subscribe('session:token', (payload) => late.push(payload));

    expect(late).toEqual([]);
    hub.dispatch({ channel: 'session:token', payload: 'live' });
    expect(late).toEqual(['live']);
  });

  it('stops delivering after unsubscribe', () => {
    const hub = createIpcEventHub<TestEventMap>();
    const received: string[] = [];
    const unsubscribe = hub.subscribe('session:token', (payload) => received.push(payload));

    hub.dispatch({ channel: 'session:token', payload: 'one' });
    unsubscribe();
    hub.dispatch({ channel: 'session:token', payload: 'two' });

    expect(received).toEqual(['one']);
  });

  it('drops events arriving after the first subscription ended (no re-buffering)', () => {
    const hub = createIpcEventHub<TestEventMap>();
    hub.subscribe('session:token', () => {})();

    hub.dispatch({ channel: 'session:token', payload: 'lost' });

    const received: string[] = [];
    hub.subscribe('session:token', (payload) => received.push(payload));
    expect(received).toEqual([]);
  });

  it('caps the buffer, dropping oldest first and reporting drops', () => {
    const onDrop = vi.fn();
    const hub = createIpcEventHub<TestEventMap>({ maxBufferedPerChannel: 2, onDrop });
    hub.dispatch({ channel: 'session:token', payload: 'a' });
    hub.dispatch({ channel: 'session:token', payload: 'b' });
    hub.dispatch({ channel: 'session:token', payload: 'c' });

    const received: string[] = [];
    hub.subscribe('session:token', (payload) => received.push(payload));

    expect(received).toEqual(['b', 'c']);
    expect(onDrop).toHaveBeenCalledExactlyOnceWith('session:token');
  });

  it('keeps delivering to other listeners when one throws', () => {
    const onListenerError = vi.fn();
    const hub = createIpcEventHub<TestEventMap>({ onListenerError });
    hub.subscribe('session:token', () => {
      throw new Error('boom');
    });
    const received: string[] = [];
    hub.subscribe('session:token', (payload) => received.push(payload));

    hub.dispatch({ channel: 'session:token', payload: 'x' });

    expect(received).toEqual(['x']);
    expect(onListenerError).toHaveBeenCalledOnce();
  });

  it('ignores malformed envelopes from the process boundary', () => {
    const hub = createIpcEventHub<TestEventMap>();
    expect(() => {
      hub.dispatch(undefined as unknown as IpcEventEnvelope);
      hub.dispatch({} as IpcEventEnvelope);
      hub.dispatch({ channel: 7, payload: null } as unknown as IpcEventEnvelope);
    }).not.toThrow();
  });
});
