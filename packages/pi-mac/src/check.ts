/**
 * `checkTcc` — spawn `pi-mac --check`, parse its single JSON line, and return a
 * typed {@link TccStatus}. Total by construction: a spawn error, a crash, or
 * garbage output all resolve to `{ accessibility:false, screenRecording:false }`
 * rather than rejecting, so the capability gate always gets a clean answer (the
 * whole feature is a no-op off-platform). Mirrors @pi-desktop/afm's check.ts.
 */
import { helperPath } from './helper-path.js';
import { defaultSpawn, type MacSpawnFn } from './spawn.js';
import type { TccStatus } from './types.js';

export interface CheckTccOptions {
  /** Explicit helper binary path (packaged app injects the bundle path). */
  readonly helperPath?: string;
  /** Injectable spawn for tests. */
  readonly spawnFn?: MacSpawnFn;
  /** Give up after this many ms and resolve unavailable. Default 10s. */
  readonly timeoutMs?: number;
}

const DENIED: TccStatus = { accessibility: false, screenRecording: false };

export function parseCheckLine(raw: string): TccStatus | undefined {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .at(-1);
  if (line === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  return {
    accessibility: obj.accessibility === true,
    screenRecording: obj.screenRecording === true,
  };
}

export function checkTcc(options: CheckTccOptions = {}): Promise<TccStatus> {
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const bin = helperPath(options.helperPath);
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise<TccStatus>((resolve) => {
    let child: ReturnType<MacSpawnFn>;
    try {
      child = spawnFn(bin, ['--check']);
    } catch {
      resolve(DENIED);
      return;
    }

    let stdout = '';
    let settled = false;
    const finish = (value: TccStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      finish(DENIED);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.on('error', () => finish(DENIED));
    child.on('close', () => finish(parseCheckLine(stdout) ?? DENIED));
  });
}
