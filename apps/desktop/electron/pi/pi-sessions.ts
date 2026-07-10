/**
 * Electron-free core of the per-window pi session registry: bridge lifecycle
 * keyed by sender (WebContents) id, pending-dialog mirroring/replay, and the
 * pi:* handler implementations. pi-main.ts injects the Electron specifics
 * (real PiBridge factory, event wire, ipcMain registration); structural
 * slices keep this module unit-testable in plain Node (quit-hold.ts
 * precedent).
 */

import type {
  AgentMessage,
  BashResult,
  ExtensionUiAnswer,
  ExtensionUiDialogMethod,
  ImageContent,
  Model,
  PiBridgeEvent,
  RpcExtensionUIRequest,
  RpcSessionState,
  RpcSlashCommand,
} from '@pi-desktop/engine';
import type { PiInvokeMap } from './contract';

/** Structural slice of PiBridge used by the registry (tests inject fakes).
 * Read/query commands go through `send` so per-channel timeouts (the
 * foundation-hardening handoff) can be applied via the engine's opt-in
 * `send(cmd, { timeoutMs })`; prompt/steer/abort deliberately have none. */
export interface SessionBridge {
  readonly alive: boolean;
  readonly pid: number;
  readonly spawnPlan: { readonly source: string };
  ready(): Promise<void>;
  send(
    cmd: { type: string; [key: string]: unknown },
    opts?: { timeoutMs?: number },
  ): Promise<{ success: boolean; data?: unknown }>;
  prompt(
    message: string,
    opts?: { images?: ImageContent[]; streamingBehavior?: 'steer' | 'followUp' },
  ): Promise<unknown>;
  steer(message: string): Promise<unknown>;
  abort(): Promise<unknown>;
  bash(command: string): Promise<{ data: BashResult }>;
  respondUi(id: string, answer: ExtensionUiAnswer): boolean;
  whenExited(): Promise<void>;
  killNow(): void;
  dispose(): void;
}

/** Per-channel send timeouts (foundation-hardening handoff, Lane A): reads are
 * cheap and must fail fast; model/session mutations get more headroom; the
 * generative commands (prompt/steer/abort) are never timed out. */
const TIMEOUT_READ_MS = 10_000;
const TIMEOUT_MUTATE_MS = 30_000;

/** Structural slice of WebContents used per attached renderer. */
export interface SessionSender {
  readonly id: number;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): void;
  on(
    event: 'render-process-gone',
    listener: (event: unknown, details: { reason: string }) => void,
  ): void;
}

export interface SessionLog {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

export interface PiSessionsDeps<S extends SessionSender> {
  /** Constructs the pi child bridge (pi-main injects the real PiBridge).
   * `extensionsDisabled` lets the registry respawn extension-free when a
   * loaded extension crashes pi at startup (graceful degradation). */
  createBridge: (
    req: PiInvokeMap['pi:start']['request'],
    onEvent: (event: PiBridgeEvent) => void,
    opts?: { extensionsDisabled?: boolean },
  ) => SessionBridge;
  /** Fans a bridge event out to the renderer (the 'pi:event' wire). */
  sendEvent: (sender: S, event: PiBridgeEvent) => void;
  log: SessionLog;
}

export type PiSessionHandlers<S extends SessionSender> = {
  [K in keyof PiInvokeMap]: (
    sender: S,
    request: PiInvokeMap[K]['request'],
  ) => PiInvokeMap[K]['response'] | Promise<PiInvokeMap[K]['response']>;
};

export interface PiSessions<S extends SessionSender> {
  /** One handler per pi channel; pi-main.ts wires these to ipcMain.handle. */
  readonly handlers: PiSessionHandlers<S>;
  /** Live view of the registry (the quit hold snapshots this). */
  bridges(): SessionBridge[];
  dispose(wcId: number): void;
  disposeAll(): void;
}

/** Only these methods block pi until respondUi; mirror of the bridge's own
 * dialog-id predicate (see PiBridge.handleLine). */
const DIALOG_METHODS: ReadonlySet<string> = new Set([
  'confirm',
  'select',
  'input',
  'editor',
] satisfies ExtensionUiDialogMethod[]);

interface SessionEntry {
  readonly bridge: SessionBridge;
  /** The spawn request, kept so pi:restart can respawn with the same cwd/session. */
  readonly req: PiInvokeMap['pi:start']['request'];
  /**
   * Blocking extension_ui_request events awaiting a reply, mirrored from the
   * bridge's private dialog tracking (`respondUi() === true` is exactly the
   * bridge-side delete). Their ids exist nowhere else once the renderer that
   * received them reloads or crashes, so 'pi:start' replays these to any
   * re-attaching renderer — otherwise pi stays wedged on the dialog forever.
   */
  readonly pendingDialogs: Map<string, RpcExtensionUIRequest>;
}

async function ack(promise: Promise<unknown>): Promise<{ success: boolean; error?: string }> {
  try {
    await promise;
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error instanceof Error ? error.message : error) };
  }
}

export function createPiSessions<S extends SessionSender>(deps: PiSessionsDeps<S>): PiSessions<S> {
  const entries = new Map<number, SessionEntry>();

  function liveEntry(wcId: number): SessionEntry | undefined {
    const entry = entries.get(wcId);
    return entry?.bridge.alive ? entry : undefined;
  }

  function bridgeFor(sender: S): SessionBridge | undefined {
    return liveEntry(sender.id)?.bridge;
  }

  function dispose(wcId: number): void {
    const entry = entries.get(wcId);
    if (entry !== undefined) {
      entries.delete(wcId);
      entry.bridge.dispose();
      deps.log.info('pi bridge disposed', { wcId });
    }
  }

  function disposeAll(): void {
    for (const wcId of [...entries.keys()]) dispose(wcId);
  }

  function attach(
    sender: S,
    req: PiInvokeMap['pi:start']['request'],
    extensionsDisabled = false,
  ): SessionEntry {
    const wcId = sender.id;
    // Hook sender lifecycle exactly once per WebContents: a dead bridge stays
    // in the map across pi restarts (dispose only runs on destroy/quit), so
    // map membership doubles as the "already hooked" flag. Re-registering on
    // every restart accumulated listeners unboundedly on a crash-looping pi.
    if (!entries.has(wcId)) {
      sender.once('destroyed', () => dispose(wcId));
      // A crashed renderer does NOT destroy its WebContents. Keep the bridge:
      // a reload re-attaches via 'pi:start', which replays pending dialogs.
      sender.on('render-process-gone', (_event, details) => {
        deps.log.warn('renderer gone; keeping pi bridge for reload recovery', {
          wcId,
          reason: details.reason,
        });
      });
    }
    const pendingDialogs = new Map<string, RpcExtensionUIRequest>();
    const bridge = deps.createBridge(
      req,
      (event) => {
        if (event.type === 'extension_ui_request' && DIALOG_METHODS.has(event.method)) {
          pendingDialogs.set(event.id, event);
        }
        if (!sender.isDestroyed()) deps.sendEvent(sender, event);
      },
      { extensionsDisabled },
    );
    // Only reachable once the previous bridge is dead (liveEntry gates on
    // alive), but dispose explicitly so a replaced bridge is never orphaned.
    entries.get(wcId)?.bridge.dispose();
    const entry: SessionEntry = { bridge, req, pendingDialogs };
    entries.set(wcId, entry);
    deps.log.info('pi bridge spawned', {
      wcId,
      pid: bridge.pid,
      source: bridge.spawnPlan.source,
      extensionsDisabled,
    });
    return entry;
  }

  /**
   * Spawn a fresh bridge and await readiness; if a loaded extension crashed pi
   * at startup (the bridge is already dead once ready resolves), respawn once
   * extension-free so a broken/WIP extension degrades to a working session
   * instead of a crash loop.
   */
  async function spawnFresh(
    sender: S,
    req: PiInvokeMap['pi:start']['request'],
  ): Promise<SessionEntry> {
    const entry = attach(sender, req);
    await entry.bridge.ready();
    if (!entry.bridge.alive) {
      deps.log.warn('pi exited at startup; retrying without extensions', { wcId: sender.id });
      const safe = attach(sender, req, true);
      await safe.bridge.ready();
      return safe;
    }
    return entry;
  }

  const handlers: PiSessionHandlers<S> = {
    'pi:start': async (sender, req) => {
      const existing = liveEntry(sender.id);
      if (existing !== undefined) {
        // A renderer re-attaching to a live bridge (reload, or recovery after
        // render-process-gone): replay the dialogs pi is still blocked on so
        // the fresh renderer can answer them.
        for (const dialog of existing.pendingDialogs.values()) {
          deps.sendEvent(sender, dialog);
        }
        return { pid: existing.bridge.pid, alreadyRunning: true };
      }
      const entry = await spawnFresh(sender, req ?? {});
      return { pid: entry.bridge.pid, alreadyRunning: false };
    },

    'pi:prompt': (sender, req) => {
      const bridge = bridgeFor(sender);
      if (bridge === undefined) return { success: false, error: 'pi is not running' };
      return ack(
        bridge.prompt(req.message, {
          images: req.images,
          streamingBehavior: req.streamingBehavior,
        }),
      );
    },

    'pi:steer': (sender, req) => {
      const bridge = bridgeFor(sender);
      if (bridge === undefined) return { success: false, error: 'pi is not running' };
      return ack(bridge.steer(req.message));
    },

    'pi:abort': (sender) => {
      const bridge = bridgeFor(sender);
      if (bridge === undefined) return { success: false, error: 'pi is not running' };
      return ack(bridge.abort());
    },

    'pi:set-model': async (sender, req) => {
      const bridge = bridgeFor(sender);
      if (bridge === undefined) return { success: false, error: 'pi is not running' };
      return ack(
        bridge.send(
          { type: 'set_model', provider: req.provider, modelId: req.modelId },
          { timeoutMs: TIMEOUT_MUTATE_MS },
        ),
      );
    },

    'pi:set-session-name': async (sender, req) => {
      const bridge = bridgeFor(sender);
      if (bridge === undefined) return { success: false, error: 'pi is not running' };
      return ack(
        bridge.send({ type: 'set_session_name', name: req.name }, { timeoutMs: TIMEOUT_MUTATE_MS }),
      );
    },

    'pi:respond-ui': (sender, req) => {
      const entry = liveEntry(sender.id);
      const delivered = entry?.bridge.respondUi(req.id, req.answer) ?? false;
      if (delivered) entry?.pendingDialogs.delete(req.id);
      return { delivered };
    },

    'pi:get-messages': async (sender) => {
      const bridge = bridgeFor(sender);
      if (bridge === undefined) {
        return { success: false, messages: [], error: 'pi is not running' };
      }
      try {
        const res = await bridge.send({ type: 'get_messages' }, { timeoutMs: TIMEOUT_READ_MS });
        return { success: true, messages: (res.data as { messages: AgentMessage[] }).messages };
      } catch (error) {
        return { success: false, messages: [], error: String(error) };
      }
    },

    'pi:switch-session': async (sender, req) => {
      const bridge = bridgeFor(sender);
      if (bridge === undefined) return { success: false, error: 'pi is not running' };
      try {
        const res = await bridge.send(
          { type: 'switch_session', sessionPath: req.sessionPath },
          { timeoutMs: TIMEOUT_MUTATE_MS },
        );
        return { success: true, cancelled: (res.data as { cancelled?: boolean }).cancelled };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    'pi:fork': async (sender, req) => {
      const bridge = bridgeFor(sender);
      if (bridge === undefined) return { success: false, error: 'pi is not running' };
      try {
        const res = await bridge.send(
          { type: 'fork', entryId: req.entryId },
          { timeoutMs: TIMEOUT_MUTATE_MS },
        );
        const data = res.data as { text?: string; cancelled?: boolean };
        return { success: true, text: data.text, cancelled: data.cancelled };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    'pi:get-fork-messages': async (sender) => {
      const bridge = bridgeFor(sender);
      if (bridge === undefined) {
        return { success: false, messages: [], error: 'pi is not running' };
      }
      try {
        const res = await bridge.send(
          { type: 'get_fork_messages' },
          { timeoutMs: TIMEOUT_READ_MS },
        );
        return {
          success: true,
          messages: (res.data as { messages: Array<{ entryId: string; text: string }> }).messages,
        };
      } catch (error) {
        return { success: false, messages: [], error: String(error) };
      }
    },

    'pi:get-state': async (sender) => {
      const bridge = bridgeFor(sender);
      if (bridge === undefined) return { success: false, error: 'pi is not running' };
      try {
        const res = await bridge.send({ type: 'get_state' }, { timeoutMs: TIMEOUT_READ_MS });
        return { success: true, state: res.data as RpcSessionState };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    'pi:get-models': async (sender) => {
      const bridge = bridgeFor(sender);
      if (bridge === undefined) return { success: false, models: [], error: 'pi is not running' };
      try {
        const res = await bridge.send(
          { type: 'get_available_models' },
          { timeoutMs: TIMEOUT_MUTATE_MS },
        );
        return { success: true, models: (res.data as { models: Model[] }).models };
      } catch (error) {
        return { success: false, models: [], error: String(error) };
      }
    },

    'pi:get-commands': async (sender) => {
      const bridge = bridgeFor(sender);
      if (bridge === undefined) return { success: false, commands: [], error: 'pi is not running' };
      try {
        const res = await bridge.send({ type: 'get_commands' }, { timeoutMs: TIMEOUT_READ_MS });
        return { success: true, commands: (res.data as { commands: RpcSlashCommand[] }).commands };
      } catch (error) {
        return { success: false, commands: [], error: String(error) };
      }
    },

    'pi:bash': async (sender, req) => {
      const bridge = bridgeFor(sender);
      if (bridge === undefined) return { success: false, error: 'pi is not running' };
      try {
        const res = await bridge.bash(req.command);
        return { success: true, result: res.data };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    // dispose → whenExited → respawn. pi:start returns the wedged-but-alive
    // bridge unchanged, so a stuck pi can only be recovered through here.
    'pi:restart': async (sender, req) => {
      const wcId = sender.id;
      const entry = entries.get(wcId);
      if (entry === undefined) return { success: false, error: 'pi is not running' };
      const spawnReq = req ?? entry.req;
      entry.bridge.dispose();
      await entry.bridge.whenExited();
      const fresh = await spawnFresh(sender, spawnReq);
      deps.log.info('pi bridge restarted', { wcId, pid: fresh.bridge.pid });
      return { success: true, pid: fresh.bridge.pid };
    },
  };

  return {
    handlers,
    bridges: () => [...entries.values()].map((entry) => entry.bridge),
    dispose,
    disposeAll,
  };
}
