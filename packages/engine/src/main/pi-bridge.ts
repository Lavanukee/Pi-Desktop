/**
 * PiBridge — wraps a `pi --mode rpc` child process.
 *
 * Ported from RemotePi desktop/electron/pi-bridge.ts. Kept behaviors:
 * - strict JSONL framing (LF-only splits; U+2028/U+2029 never treated as
 *   record delimiters — see src/main/jsonl.ts),
 * - promise-based command/response correlation by randomUUID `id`,
 * - the `type`-vs-`command` wire quirk (see {@link PiBridge.send}),
 * - dialogIds tracking so only blocking extension_ui_requests are answerable,
 * - SIGTERM → SIGKILL dispose ladder,
 * - FORCE_COLOR=0 / NO_COLOR=1 env.
 *
 * Changes from the source: binary resolution order (binPath → PI_BIN →
 * bundled cli.js → PATH, see resolve-pi.ts), `extensionPaths` → repeated `-e`
 * flags, first-event readiness with a configurable timeout fallback instead of
 * a fixed 250ms sleep, full typing against src/types/rpc.ts, and structural
 * injection of the process runtime so it unit-tests in plain Node (this module
 * never imports `electron`).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import type {
  ExtensionUiAnswer,
  PiBridgeEvent,
  RpcCommand,
  RpcErrorResponse,
  RpcSuccessResponse,
} from '../types/rpc';
import { createJsonlSplitter, serializeJsonLine } from './jsonl';
import { type PiSpawnPlan, resolvePiSpawn } from './resolve-pi';

/** Structural slice of ChildProcess so tests can inject a fake. */
export interface PiChildProcess {
  pid?: number;
  stdin: {
    write(data: string, cb?: (err?: Error | null) => void): void;
    end(): void;
    on(event: 'error', cb: (err: Error) => void): void;
  };
  stdout: { setEncoding(enc: string): void; on(event: 'data', cb: (chunk: string) => void): void };
  stderr: { setEncoding(enc: string): void; on(event: 'data', cb: (chunk: string) => void): void };
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void;
  on(event: 'close', cb: (code: number | null, signal: string | null) => void): void;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
}

export type PiSpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined>; detached?: boolean },
) => PiChildProcess;

export interface PiBridgeOptions {
  /** Working directory for the pi process; falls back to the home dir. */
  cwd?: string;
  sessionPath?: string;
  provider?: string;
  model?: string;
  /** Disable session persistence (`--no-session`). */
  noSession?: boolean;
  /** Extension files loaded via repeated `-e` flags (W5 harness extensions). */
  extensionPaths?: string[];
  /** Extra args passed straight to pi. */
  extraArgs?: string[];

  /** Explicit pi executable (highest-priority resolution). */
  binPath?: string;
  /** Root for resolving the bundled pi package (e.g. Electron app path). */
  appRoot?: string;

  /**
   * Readiness fallback: `ready()` resolves on the first parsed stdout line
   * (the bridge sends a get_state probe at spawn to elicit one) or after this
   * many ms, whichever comes first. Default 3000.
   */
  readyTimeoutMs?: number;
  /** Set false to suppress the get_state readiness probe. Default true. */
  readyProbe?: boolean;
  /** Grace period between SIGTERM and SIGKILL in dispose(). Default 1500. */
  killGraceMs?: number;

  /**
   * Spawn pi as its own process-group leader (`detached`) so dispose()/killNow()
   * can reap the WHOLE tree — pi's subagent grandchildren included — with a
   * single negative-pid group signal, instead of leaking orphaned subagent pi
   * processes on hard-kill (task #55). Default false (a plain child.kill()).
   * Production wiring (pi-main.ts) sets true; POSIX only — ignored on win32.
   */
  detached?: boolean;

  // -- structural injection (tests) ----------------------------------------
  spawnFn?: PiSpawnFn;
  /**
   * Signal a process GROUP by (negative) pid; defaults to `process.kill`.
   * Injected so the detached group-kill path is unit-testable without a real
   * process group.
   */
  killProcessGroup?: (target: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  env?: Record<string, string | undefined>;
  /** `process.execPath` stand-in for the bundled spawn plan. */
  execPath?: string;
  /** Whether execPath is an Electron binary. Default: process.versions.electron. */
  isElectron?: boolean;
  /** Override the bundled-CLI locator (tests). */
  locateBundledCli?: (appRoot: string) => string | undefined;
}

interface Pending {
  resolve: (value: RpcSuccessResponse) => void;
  reject: (err: Error) => void;
  /** Wire `type` that was sent — pi 0.68.1 drops the request id on
   * unknown-command errors, so id-less failures correlate by echoed type. */
  type: string | undefined;
  /** Opt-in per-call timeout (see {@link SendOptions.timeoutMs}). */
  timer?: ReturnType<typeof setTimeout>;
}

/** Per-call options for {@link PiBridge.send}. */
export interface SendOptions {
  /**
   * Reject with {@link PiTimeoutError} if no response arrives within this
   * many ms. Opt-in per command — never applied globally, because `prompt`/
   * `new_session`/`switch_session` can legitimately block on preflight,
   * extension dialogs, or user interaction. Budget per channel at the caller.
   */
  timeoutMs?: number;
}

/** Distinguishable rejection for {@link SendOptions.timeoutMs} expiries, so
 * callers can offer recovery (restart) instead of showing a generic error. */
export class PiTimeoutError extends Error {
  override readonly name = 'PiTimeoutError';
}

/** Loosely-shaped command for `send`: `command` is renamed to `type` on the
 * wire (the load-bearing quirk), so callers may pass either. */
export type LooseCommand = { command?: string; type?: string; id?: string } & Record<
  string,
  unknown
>;

/** pi's dialog-expiry timer starts before the request reaches us — prune our
 * side strictly after pi resolves so we never drop a still-answerable id. */
const DIALOG_EXPIRY_GRACE_MS = 250;

export class PiBridge {
  private readonly child: PiChildProcess;
  private readonly pending = new Map<string, Pending>();
  /** Ids of blocking dialog requests awaiting an extension_ui_response. */
  private readonly dialogIds = new Set<string>();
  private readonly onEvent: (e: PiBridgeEvent) => void;
  private readonly killGraceMs: number;
  /** Whether pi was spawned as its own process-group leader (see options). */
  private readonly detached: boolean;
  private readonly killProcessGroup: (target: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  private readyResolve: (() => void) | null = null;
  private readonly readyPromise: Promise<void>;
  private exitResolve: (() => void) | null = null;
  private readonly exitPromise: Promise<void>;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private exited = false;

  readonly pid: number;
  readonly spawnPlan: PiSpawnPlan;

  constructor(opts: PiBridgeOptions, onEvent: (e: PiBridgeEvent) => void) {
    this.onEvent = onEvent;
    this.killGraceMs = opts.killGraceMs ?? 1500;
    // Process-group reaping is POSIX-only (negative-pid signalling); on win32 it
    // degrades to a plain child kill.
    this.detached = opts.detached === true && process.platform !== 'win32';
    this.killProcessGroup =
      opts.killProcessGroup ?? ((target, signal) => process.kill(target, signal));
    const env = opts.env ?? process.env;

    this.spawnPlan = resolvePiSpawn({
      binPath: opts.binPath,
      appRoot: opts.appRoot,
      env,
      execPath: opts.execPath,
      isElectron: opts.isElectron,
      locateBundledCli: opts.locateBundledCli,
    });

    const args = [...this.spawnPlan.argsPrefix, '--mode', 'rpc'];
    if (opts.provider !== undefined) args.push('--provider', opts.provider);
    if (opts.model !== undefined) args.push('--model', opts.model);
    if (opts.sessionPath !== undefined) args.push('--session', opts.sessionPath);
    if (opts.noSession === true) args.push('--no-session');
    for (const extension of opts.extensionPaths ?? []) args.push('-e', extension);
    if (opts.extraArgs) args.push(...opts.extraArgs);

    const cwd = opts.cwd !== undefined && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();

    const spawnFn: PiSpawnFn = opts.spawnFn ?? ((cmd, a, o) => spawn(cmd, a, o));
    this.child = spawnFn(this.spawnPlan.command, args, {
      cwd,
      env: {
        ...env,
        ...this.spawnPlan.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      // A new session/process group so dispose()/killNow() can reap pi's own
      // subagent grandchildren via a group signal (see PiBridgeOptions.detached).
      detached: this.detached,
    });
    this.pid = this.child.pid ?? -1;

    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    this.exitPromise = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
    this.readyTimer = setTimeout(() => this.markReady(), opts.readyTimeoutMs ?? 3000);
    this.readyTimer.unref?.();

    // No handleLine/onEvent exception may propagate into the stream 'data'
    // handler — that would be an uncaughtException killing the main process.
    const splitter = createJsonlSplitter((line) => {
      try {
        this.handleLine(line);
      } catch (err) {
        try {
          this.onEvent({ type: '_bridge_error', error: `handleLine: ${String(err)}` });
        } catch {
          // Nothing left to report to; never rethrow into the stream.
        }
      }
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => splitter.push(chunk));
    this.child.stderr.on('data', (chunk) => this.onEvent({ type: '_stderr', text: chunk }));

    // Async write failures (EPIPE from a dying pi) arrive as 'error' ON THE
    // STDIN STREAM; without a listener they become an uncaughtException that
    // kills the whole main process. Do not rethrow.
    this.child.stdin.on('error', (err) => {
      this.onEvent({ type: '_bridge_error', error: `stdin: ${String(err)}` });
    });

    this.child.on('error', (err) => {
      this.onEvent({ type: '_bridge_error', error: String(err) });
      if (this.child.pid === undefined) {
        // Spawn failure (e.g. ENOENT): Node emits 'error'/'close' but never
        // 'exit', so settle here or the bridge zombies with alive === true.
        this.settleExit(new Error(`pi failed to spawn: ${String(err)}`));
      } else {
        this.markReady();
      }
    });

    this.child.on('exit', (code, signal) => {
      if (this.exited) return;
      this.settleExit(new Error(`pi exited (${signal ?? code})`));
      this.onEvent({ type: '_bridge_exit', code, signal });
    });

    // Belt-and-braces: 'close' is guaranteed-terminal even on paths where
    // 'exit' never fires.
    this.child.on('close', (code, signal) => {
      if (this.exited) return;
      this.settleExit(new Error(`pi exited (${signal ?? code})`));
      this.onEvent({ type: '_bridge_exit', code, signal });
    });

    if (opts.readyProbe !== false) {
      // Elicit the first stdout line deterministically; the response doubles
      // as an initial-state event for listeners.
      this.send({ type: 'get_state' }).catch(() => {
        // Probe failures surface via _bridge_* events; nothing to do here.
      });
    }
  }

  /** True until the child exits. */
  get alive(): boolean {
    return !this.exited;
  }

  /** Resolves on the first parsed stdout line, the ready timeout, spawn
   * failure, or exit — whichever comes first. Never rejects; failures surface
   * as `_bridge_*` events. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Resolves once the child reaches a terminal state (exit, close, or spawn
   * failure). Already-settled bridges resolve immediately. Never rejects. */
  whenExited(): Promise<void> {
    return this.exitPromise;
  }

  private markReady(): void {
    if (this.readyTimer !== null) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.readyResolve?.();
    this.readyResolve = null;
  }

  /** Terminal settlement, shared by 'exit', 'close', and failed spawns
   * ('error' with no pid — Node never emits 'exit' in that case). */
  private settleExit(reason: Error): void {
    if (this.exited) return;
    this.exited = true;
    if (this.killTimer !== null) clearTimeout(this.killTimer);
    this.killTimer = null;
    this.markReady();
    this.exitResolve?.();
    this.exitResolve = null;
    for (const p of this.pending.values()) {
      if (p.timer !== undefined) clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
  }

  /** Remove and return a pending entry, clearing its timeout timer. */
  private takePending(id: string): Pending | undefined {
    const pending = this.pending.get(id);
    if (pending === undefined) return undefined;
    this.pending.delete(id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    return pending;
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not JSON — startup banner or leaking diagnostics; pass through.
      this.onEvent({ type: '_unparsed', text: line });
      return;
    }
    // JSON.parse also succeeds for bare primitives/arrays (`console.log(null)`
    // in an extension emits the line `null`); property access on null would
    // throw inside the stream 'data' handler. Only typed objects are protocol
    // lines — everything else passes through without marking readiness.
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof (parsed as { type?: unknown }).type !== 'string'
    ) {
      this.onEvent({ type: '_unparsed', text: line });
      return;
    }
    const msg = parsed as PiBridgeEvent;
    // Any parsed protocol line proves pi is up.
    this.markReady();

    if (msg.type === 'response') {
      const pending = msg.id !== undefined ? this.takePending(msg.id) : undefined;
      if (pending !== undefined) {
        if (msg.success === false) {
          pending.reject(new Error((msg as RpcErrorResponse).error || 'Pi RPC command failed'));
        } else {
          pending.resolve(msg);
        }
      } else if (msg.id === undefined && msg.success === false) {
        // pi 0.68.1 drops the request id when rejecting unknown command types
        // (and unparseable input echoes command:"parse"). Correlate by the
        // echoed command so the awaiting send() rejects instead of hanging
        // forever; 2+ matches are ambiguous and fall through to events only.
        const command = (msg as RpcErrorResponse).command as string | undefined;
        const matches = [...this.pending.keys()].filter(
          (id) => this.pending.get(id)?.type === command,
        );
        const onlyId = matches.length === 1 ? matches[0] : undefined;
        const orphan = onlyId !== undefined ? this.takePending(onlyId) : undefined;
        orphan?.reject(new Error((msg as RpcErrorResponse).error || 'Pi RPC command failed'));
      }
      // Responses (matched or orphaned) also flow to listeners as events.
      this.onEvent(msg);
      return;
    }

    if (msg.type === 'extension_ui_request') {
      // Only dialog methods block pi on a reply; track their ids so respondUi
      // can't be abused to answer fire-and-forget requests.
      if (
        msg.method === 'confirm' ||
        msg.method === 'select' ||
        msg.method === 'input' ||
        msg.method === 'editor'
      ) {
        this.dialogIds.add(msg.id);
        // pi auto-resolves the dialog on its side at `timeout` without any
        // event; prune the id then (plus a grace margin) so a late respondUi
        // no-ops instead of writing a response pi silently ignores.
        const timeout = (msg as { timeout?: unknown }).timeout;
        if (typeof timeout === 'number' && timeout > 0) {
          const requestId = msg.id;
          const pruneTimer = setTimeout(
            () => this.dialogIds.delete(requestId),
            timeout + DIALOG_EXPIRY_GRACE_MS,
          );
          pruneTimer.unref?.();
        }
      }
    }

    this.onEvent(msg);
  }

  /**
   * Send a command and await its response.
   *
   * Wire format quirk (load-bearing): pi's RPC discriminator field is `type`,
   * not `command` — rpc-types.ts is the source of truth. Callers may still
   * pass `{command: "prompt"}` for ergonomics; it is renamed here. Sending
   * `{command: "prompt"}` verbatim yields `Unknown command: undefined` and
   * silently swallows every prompt. The rename applies ONLY when `type` is
   * absent: `bash` legitimately carries a payload field named `command`
   * ({type:"bash", command:"ls"}), which must reach the wire intact.
   */
  send<C extends RpcCommand>(cmd: C, opts?: SendOptions): Promise<RpcSuccessResponse<C['type']>>;
  send(cmd: LooseCommand, opts?: SendOptions): Promise<RpcSuccessResponse>;
  send(cmd: LooseCommand, opts: SendOptions = {}): Promise<RpcSuccessResponse> {
    const id = cmd.id ?? randomUUID();
    let payload: Record<string, unknown>;
    if (cmd.type !== undefined) {
      payload = { ...cmd, id };
    } else {
      const { command, ...rest } = cmd;
      payload = { ...rest, type: command, id };
    }
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new Error('pi process has exited'));
        return;
      }
      const pending: Pending = {
        resolve,
        reject,
        type: typeof payload.type === 'string' ? payload.type : undefined,
      };
      if (opts.timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(
              new PiTimeoutError(
                `pi did not respond to ${String(payload.type)} within ${opts.timeoutMs}ms`,
              ),
            );
          }
        }, opts.timeoutMs);
        pending.timer.unref?.();
      }
      this.pending.set(id, pending);
      // Failures may be synchronous throws or async write-callback errors
      // (real streams report EPIPE via the callback, never by throwing).
      const onWriteError = (err: Error): void => {
        if (this.takePending(id) !== undefined) reject(err);
      };
      try {
        this.child.stdin.write(serializeJsonLine(payload), (err) => {
          if (err != null) onWriteError(err);
        });
      } catch (err) {
        onWriteError(err as Error);
      }
    });
  }

  /** Typed convenience wrappers over {@link send}. */
  prompt(
    message: string,
    opts?: {
      images?: Extract<RpcCommand, { type: 'prompt' }>['images'];
      streamingBehavior?: 'steer' | 'followUp';
    },
  ): Promise<RpcSuccessResponse<'prompt'>> {
    return this.send({ type: 'prompt', message, ...opts });
  }

  steer(message: string): Promise<RpcSuccessResponse<'steer'>> {
    return this.send({ type: 'steer', message });
  }

  abort(): Promise<RpcSuccessResponse<'abort'>> {
    return this.send({ type: 'abort' });
  }

  /** Run a shell command through pi (the composer's `!` bash mode). */
  bash(command: string): Promise<RpcSuccessResponse<'bash'>> {
    return this.send({ type: 'bash', command });
  }

  getState(): Promise<RpcSuccessResponse<'get_state'>> {
    return this.send({ type: 'get_state' });
  }

  getMessages(): Promise<RpcSuccessResponse<'get_messages'>> {
    return this.send({ type: 'get_messages' });
  }

  getAvailableModels(): Promise<RpcSuccessResponse<'get_available_models'>> {
    return this.send({ type: 'get_available_models' });
  }

  setModel(provider: string, modelId: string): Promise<RpcSuccessResponse<'set_model'>> {
    return this.send({ type: 'set_model', provider, modelId });
  }

  switchSession(sessionPath: string): Promise<RpcSuccessResponse<'switch_session'>> {
    return this.send({ type: 'switch_session', sessionPath });
  }

  newSession(parentSession?: string): Promise<RpcSuccessResponse<'new_session'>> {
    return this.send({ type: 'new_session', parentSession });
  }

  /**
   * Reply to a blocking extension_ui_request. No-ops (returns false) for
   * unknown ids and fire-and-forget requests.
   */
  respondUi(id: string, answer: ExtensionUiAnswer): boolean {
    if (!this.dialogIds.has(id)) return false;
    this.dialogIds.delete(id);
    try {
      this.child.stdin.write(serializeJsonLine({ type: 'extension_ui_response', id, ...answer }));
      return true;
    } catch (err) {
      this.onEvent({ type: '_bridge_error', error: `respondUi: ${String(err)}` });
      return false;
    }
  }

  /**
   * SIGTERM/SIGKILL the pi process. When pi was spawned detached (a process-group
   * leader), signal the whole GROUP via the negative pid so pi's subagent
   * grandchildren are reaped too — otherwise a hard-kill of the direct child
   * orphans the subagents it spawned (task #55). Falls back to a direct child
   * kill if the group signal throws (group already gone, or non-POSIX) or pi has
   * no pid.
   */
  private signalTree(signal: 'SIGTERM' | 'SIGKILL'): void {
    const pid = this.child.pid;
    if (this.detached && typeof pid === 'number' && pid > 0) {
      try {
        this.killProcessGroup(-pid, signal);
        return;
      } catch {
        // Group gone / unsupported — fall through to a direct child kill.
      }
    }
    try {
      this.child.kill(signal);
    } catch {
      // Process may already be gone.
    }
  }

  /** Kill ladder: close stdin, SIGTERM, then SIGKILL if it lingers. Reaps the
   * whole process tree (pi + subagents) when spawned detached. */
  dispose(): void {
    try {
      this.child.stdin.end();
    } catch {
      // stdin may already be destroyed.
    }
    this.signalTree('SIGTERM');
    if (!this.exited && this.killTimer === null) {
      this.killTimer = setTimeout(() => this.signalTree('SIGKILL'), this.killGraceMs);
      this.killTimer.unref?.();
    }
  }

  /** Immediate SIGKILL, bypassing dispose()'s grace timer. The app-quit path
   * needs this: the unref'd timer dies with the process. Reaps the whole tree. */
  killNow(): void {
    if (this.killTimer !== null) clearTimeout(this.killTimer);
    this.killTimer = null;
    this.signalTree('SIGKILL');
  }
}

/** Bridge command surface as seen by callers (send + typed helpers). */
export type PiBridgeApi = Pick<
  PiBridge,
  | 'send'
  | 'prompt'
  | 'steer'
  | 'abort'
  | 'bash'
  | 'getState'
  | 'getMessages'
  | 'getAvailableModels'
  | 'setModel'
  | 'switchSession'
  | 'newSession'
  | 'respondUi'
  | 'dispose'
  | 'killNow'
  | 'ready'
  | 'whenExited'
>;
