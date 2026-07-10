/**
 * `streamAfm` — spawn `pi-afm --respond`, write the JSON request to stdin, parse
 * the helper's NDJSON deltas, and drive `onDelta` as tokens arrive. Resolves on
 * the terminal `done` line; rejects with a normalized {@link AfmError} on an
 * in-band `error` line or an unexpected exit, and with {@link AfmAbortError}
 * when the caller's signal fires (the child is SIGKILLed).
 *
 * Electron-free; `spawnFn` is injectable so it unit-tests without the real
 * binary (mirrors the llama-server supervisor).
 */
import { AfmAbortError, AfmError } from './errors.js';
import { helperPath } from './helper-path.js';
import { type AfmChildProcess, type AfmSpawnFn, defaultSpawn } from './spawn.js';
import type { AfmDelta, AfmRequest, AfmStreamResult, AfmUsage } from './types.js';

export interface StreamAfmOptions {
  /** Called with each incremental text delta as it streams. */
  readonly onDelta?: (text: string) => void;
  /** Aborts the request and kills the child. */
  readonly signal?: AbortSignal;
  /** Explicit helper binary path (packaged app injects the bundle path). */
  readonly helperPath?: string;
  /** Injectable spawn for tests. */
  readonly spawnFn?: AfmSpawnFn;
}

export function streamAfm(
  request: AfmRequest,
  options: StreamAfmOptions = {},
): Promise<AfmStreamResult> {
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const bin = helperPath(options.helperPath);

  return new Promise<AfmStreamResult>((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(new AfmAbortError());
      return;
    }

    let child: AfmChildProcess;
    try {
      child = spawnFn(bin, ['--respond']);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let settled = false;
    let sawTerminal = false;
    let text = '';
    let usage: AfmUsage | undefined;
    let buffer = '';
    let stderr = '';

    const onAbort = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      settleReject(new AfmAbortError());
    };

    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', onAbort);
    };
    function settleResolve(value: AfmStreamResult): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }
    function settleReject(err: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    if (options.signal !== undefined) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const handleLine = (raw: string): void => {
      if (settled) return;
      const line = raw.trim();
      if (line.length === 0) return;
      let msg: AfmDelta;
      try {
        msg = JSON.parse(line) as AfmDelta;
      } catch {
        return; // ignore non-JSON keep-alives / stray output
      }
      if (msg.type === 'delta') {
        text += msg.text;
        options.onDelta?.(msg.text);
      } else if (msg.type === 'done') {
        sawTerminal = true;
        usage = msg.usage;
        settleResolve({ text, ...(usage !== undefined ? { usage } : {}) });
        killQuietly();
      } else if (msg.type === 'error') {
        sawTerminal = true;
        settleReject(new AfmError(msg.message, msg.recoverable));
        killQuietly();
      }
    };

    const killQuietly = (): void => {
      try {
        child.kill();
      } catch {
        // already exiting
      }
    };

    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const lineText = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        handleLine(lineText);
        newlineIndex = buffer.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (err) => settleReject(err));
    child.on('close', (code) => {
      if (buffer.trim().length > 0) handleLine(buffer);
      if (settled) return;
      if (!sawTerminal) {
        const detail = stderr.trim().length > 0 ? `: ${stderr.trim().slice(0, 500)}` : '';
        settleReject(
          new AfmError(
            `pi-afm exited (code ${code ?? 'null'}) without a done/error line${detail}`,
            false,
          ),
        );
      }
    });

    const payload = JSON.stringify(request);
    try {
      child.stdin?.on('error', (err) => settleReject(err));
      child.stdin?.write(payload, (err) => {
        if (err != null) settleReject(err);
      });
      child.stdin?.end();
    } catch (err) {
      settleReject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
