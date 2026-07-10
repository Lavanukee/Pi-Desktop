/**
 * `checkAvailability` — spawn `pi-afm --check`, parse its single JSON line, and
 * return a typed {@link AfmAvailability}. Total by construction: a spawn error,
 * a crash, or garbage output all resolve to an `unsupportedOS`/unavailable
 * result rather than rejecting, so the app's capability gate always gets a
 * clean answer (the whole feature is a no-op off-platform).
 */

import { helperPath } from './helper-path.js';
import type { AfmSpawnFn } from './spawn.js';
import { defaultSpawn } from './spawn.js';
import type { AfmAvailability, AfmReason } from './types.js';

export interface CheckOptions {
  /** Explicit helper binary path (packaged app injects the bundle path). */
  readonly helperPath?: string;
  /** Injectable spawn for tests. */
  readonly spawnFn?: AfmSpawnFn;
  /** Give up after this many ms and resolve unavailable. Default 10s. */
  readonly timeoutMs?: number;
}

const VALID_REASONS: ReadonlySet<AfmReason> = new Set<AfmReason>([
  'available',
  'deviceNotEligible',
  'appleIntelligenceNotEnabled',
  'modelNotReady',
  'unsupportedOS',
]);

/** The safe fallback returned whenever we can't get a clean line from the helper. */
function unavailable(reason: AfmReason = 'unsupportedOS'): AfmAvailability {
  return { available: false, reason, contextWindow: 4096, model: '' };
}

function parseCheckLine(raw: string): AfmAvailability | undefined {
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
  const reason = (
    VALID_REASONS.has(obj.reason as AfmReason) ? obj.reason : 'unsupportedOS'
  ) as AfmReason;
  return {
    available: obj.available === true,
    reason,
    contextWindow: typeof obj.contextWindow === 'number' ? obj.contextWindow : 4096,
    model: typeof obj.model === 'string' ? obj.model : '',
  };
}

export function checkAvailability(options: CheckOptions = {}): Promise<AfmAvailability> {
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const bin = helperPath(options.helperPath);
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise<AfmAvailability>((resolve) => {
    let child: ReturnType<AfmSpawnFn>;
    try {
      child = spawnFn(bin, ['--check']);
    } catch {
      resolve(unavailable());
      return;
    }

    let stdout = '';
    let settled = false;
    const finish = (value: AfmAvailability): void => {
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
      finish(unavailable());
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.on('error', () => finish(unavailable()));
    child.on('close', () => finish(parseCheckLine(stdout) ?? unavailable()));
  });
}
