/**
 * Typed IPC contracts shared between Electron main, preload, and renderer.
 *
 * Transport-agnostic by design: helpers accept structural interfaces matching the
 * small slice of Electron's `ipcRenderer` / `ipcMain` they actually use, so this
 * package never imports `electron` and stays unit-testable in plain Node.
 *
 * Conventions (see docs/architecture.md):
 * - Channel maps are `type` aliases (not interfaces) so they satisfy the
 *   `Record` constraints below.
 * - Invoke channels are named `domain:action` (e.g. `app:get-info`).
 * - Main → renderer events travel over a single multiplexed wire channel
 *   ({@link IPC_EVENT_CHANNEL}) as {@link IpcEventEnvelope}s and are fanned out
 *   by an {@link IpcEventHub} in the preload script.
 */

/** One `invoke`-style round trip: what the renderer sends and what main returns. */
export interface IpcInvokeContract {
  request: unknown;
  response: unknown;
}

/** Channel name → request/response contract for `ipcRenderer.invoke` round trips. */
export type IpcInvokeMap = Record<string, IpcInvokeContract>;

/** Event channel name → payload type for main → renderer push events. */
export type IpcEventMap = Record<string, unknown>;

/** The single multiplexed wire channel used for all main → renderer events. */
export const IPC_EVENT_CHANNEL = 'pi-desktop:event';

/** Wire format for events on {@link IPC_EVENT_CHANNEL}. */
export interface IpcEventEnvelope {
  readonly channel: string;
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// invoke / handle
// ---------------------------------------------------------------------------

/** Structural slice of Electron's `ipcRenderer`. */
export interface IpcInvokeSource {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

export interface IpcClient<M extends IpcInvokeMap> {
  invoke<K extends keyof M & string>(
    channel: K,
    request: M[K]['request'],
  ): Promise<M[K]['response']>;
}

/** Renderer/preload-side wrapper over `ipcRenderer.invoke` typed by a channel map. */
export function createIpcClient<M extends IpcInvokeMap>(ipc: IpcInvokeSource): IpcClient<M> {
  return {
    async invoke(channel, request) {
      // The handler side is registered from the same channel map, so the cast
      // only asserts what `registerIpcHandlers` already enforced.
      return (await ipc.invoke(channel, request)) as M[typeof channel]['response'];
    },
  };
}

/** Structural slice of Electron's `ipcMain`. */
export interface IpcHandlerTarget {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export type IpcHandler<M extends IpcInvokeMap, K extends keyof M> = (
  request: M[K]['request'],
) => M[K]['response'] | Promise<M[K]['response']>;

/** One handler per channel; exhaustiveness is enforced by the type. */
export type IpcHandlers<M extends IpcInvokeMap> = { [K in keyof M]: IpcHandler<M, K> };

export interface RegisterIpcHandlerOptions {
  /**
   * Sender gate (Electron security checklist: validate the sender of every
   * IPC message). Called with the raw `handle` event before dispatch;
   * returning false rejects the invoke without running the handler. The event
   * is `unknown`-typed because this package never imports `electron` — callers
   * narrow it to `IpcMainInvokeEvent` (a registration-side guarantee).
   */
  allowSender?: (event: unknown) => boolean;
}

function guardedListener(
  channel: string,
  handler: (request: unknown) => unknown,
  options: RegisterIpcHandlerOptions | undefined,
): (event: unknown, ...args: unknown[]) => unknown {
  return (event, request) => {
    if (options?.allowSender?.(event) === false) {
      throw new Error(`[ipc] rejected invoke on "${channel}": untrusted sender`);
    }
    return handler(request);
  };
}

/**
 * Main-side wrapper over `ipcMain.handle` for a single channel.
 * Both type arguments are required; prefer {@link registerIpcHandlers} which
 * registers a whole channel map at once and checks exhaustiveness.
 * Returns a dispose function that unregisters the handler.
 */
export function registerIpcHandler<M extends IpcInvokeMap, K extends keyof M & string>(
  ipc: IpcHandlerTarget,
  channel: K,
  handler: IpcHandler<M, K>,
  options?: RegisterIpcHandlerOptions,
): () => void {
  ipc.handle(
    channel,
    guardedListener(channel, (request) => handler(request as M[K]['request']), options),
  );
  return () => ipc.removeHandler(channel);
}

/**
 * Registers a handler for every channel in the map (exhaustive by construction).
 * Returns a dispose function that unregisters all of them.
 */
export function registerIpcHandlers<M extends IpcInvokeMap>(
  ipc: IpcHandlerTarget,
  handlers: IpcHandlers<M>,
  options?: RegisterIpcHandlerOptions,
): () => void {
  const entries = Object.entries(handlers) as Array<
    [keyof M & string, (request: unknown) => unknown]
  >;
  for (const [channel, handler] of entries) {
    ipc.handle(channel, guardedListener(channel, handler, options));
  }
  return () => {
    for (const [channel] of entries) {
      ipc.removeHandler(channel);
    }
  };
}

// ---------------------------------------------------------------------------
// main → renderer events
// ---------------------------------------------------------------------------

/** Structural slice of Electron's `webContents`. */
export interface IpcEventTarget {
  send(channel: string, ...args: unknown[]): void;
}

export interface IpcEventSender<E extends IpcEventMap> {
  send<K extends keyof E & string>(target: IpcEventTarget, channel: K, payload: E[K]): void;
}

/** Main-side helper: wraps typed events into envelopes on the wire channel. */
export function createIpcEventSender<E extends IpcEventMap>(): IpcEventSender<E> {
  return {
    send(target, channel, payload) {
      const envelope: IpcEventEnvelope = { channel, payload };
      target.send(IPC_EVENT_CHANNEL, envelope);
    },
  };
}

export interface IpcEventHubOptions {
  /** Max events buffered per channel before the oldest is dropped. Default 256. */
  maxBufferedPerChannel?: number;
  /** Called when a buffered event is dropped because the cap was hit. */
  onDrop?: (channel: string) => void;
  /** Called when a listener throws; delivery to other listeners continues. */
  onListenerError?: (error: unknown, channel: string) => void;
}

export interface IpcEventHub<E extends IpcEventMap> {
  /** Feed an envelope from the wire (preload calls this from `ipcRenderer.on`). */
  dispatch(envelope: IpcEventEnvelope): void;
  /**
   * Subscribe to a channel. The first subscription on a channel synchronously
   * receives all buffered pre-mount events in arrival order.
   * Returns an unsubscribe function.
   */
  subscribe<K extends keyof E & string>(channel: K, listener: (payload: E[K]) => void): () => void;
}

function reportListenerError(error: unknown, channel: string): void {
  // `console` is host-provided in every runtime we target (Node, Electron, browsers),
  // but is not part of the pure ES lib this package compiles against.
  const host = globalThis as { console?: { error(...args: unknown[]): void } };
  host.console?.error(`[ipc-event-hub] listener for "${channel}" threw`, error);
}

/**
 * Renderer-side event fan-out with a pre-mount buffer.
 *
 * Load-bearing behavior: events that arrive before the first listener attaches
 * to a channel are buffered and flushed, in order, to that first listener.
 * Electron main starts pushing events as soon as the page loads — before React
 * mounts and components subscribe — and those events must not be lost.
 *
 * The buffer exists only until a channel's first subscription; after that,
 * events arriving while a channel momentarily has zero listeners are dropped.
 */
export function createIpcEventHub<E extends IpcEventMap>(
  options: IpcEventHubOptions = {},
): IpcEventHub<E> {
  const maxBuffered = options.maxBufferedPerChannel ?? 256;
  const onListenerError = options.onListenerError ?? reportListenerError;
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const buffers = new Map<string, unknown[]>();
  const flushedChannels = new Set<string>();

  function deliver(channel: string, payload: unknown, targets: Iterable<(p: unknown) => void>) {
    for (const listener of targets) {
      try {
        listener(payload);
      } catch (error) {
        onListenerError(error, channel);
      }
    }
  }

  return {
    dispatch(envelope) {
      // Defensive: envelopes cross a process boundary.
      if (typeof envelope?.channel !== 'string') return;
      const { channel, payload } = envelope;
      const subscribers = listeners.get(channel);
      if (subscribers !== undefined && subscribers.size > 0) {
        deliver(channel, payload, [...subscribers]);
        return;
      }
      if (flushedChannels.has(channel)) return;
      let queue = buffers.get(channel);
      if (queue === undefined) {
        queue = [];
        buffers.set(channel, queue);
      }
      queue.push(payload);
      if (queue.length > maxBuffered) {
        queue.shift();
        options.onDrop?.(channel);
      }
    },

    subscribe(channel, listener) {
      let subscribers = listeners.get(channel);
      if (subscribers === undefined) {
        subscribers = new Set();
        listeners.set(channel, subscribers);
      }
      const untyped = listener as (payload: unknown) => void;
      subscribers.add(untyped);
      if (!flushedChannels.has(channel)) {
        flushedChannels.add(channel);
        const queue = buffers.get(channel);
        buffers.delete(channel);
        if (queue !== undefined) {
          for (const payload of queue) {
            deliver(channel, payload, [untyped]);
          }
        }
      }
      return () => {
        subscribers.delete(untyped);
      };
    },
  };
}
