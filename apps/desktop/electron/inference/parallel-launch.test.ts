import { assembleServerArgs, type LaunchConfig } from '@pi-desktop/inference';
import { describe, expect, it } from 'vitest';
import { fastTextSlotLaunch } from './parallel-launch';

const CONTEXT_CAP = 16_384;

/** A fast-text corp launch base (MTP embedded, spec-decode supported) minus the
 * `parallel` / `contextSize` the slot scaling supplies. */
const base = {
  modelPath: '/models/qwen.gguf',
  host: '127.0.0.1',
  port: 8080,
  launchMode: 'fast-text' as const,
  mtpSupported: true,
  mtpEmbedded: true,
};

/** Build the fast-text server args the way supervisor-entry.ts does: per-slot
 * context CONTEXT_CAP, scaled to K slots, fed through assembleServerArgs. */
function corpFastTextArgs(parallel: number | undefined): string[] {
  const launch = fastTextSlotLaunch(CONTEXT_CAP, parallel);
  const cfg: LaunchConfig = { ...base, contextSize: launch.contextSize, parallel: launch.parallel };
  return assembleServerArgs(cfg);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe('fastTextSlotLaunch — split -c across K full-context slots', () => {
  it('K=3 → parallel 3 and -c 49152 (each slot keeps 16384)', () => {
    expect(fastTextSlotLaunch(CONTEXT_CAP, 3)).toEqual({ parallel: 3, contextSize: 49_152 });
  });
  it('K=1 → parallel 1 and -c 16384 (byte-for-byte the single-slot launch)', () => {
    expect(fastTextSlotLaunch(CONTEXT_CAP, 1)).toEqual({ parallel: 1, contextSize: 16_384 });
  });
  it('unset → single slot (K=1, -c = perSlot)', () => {
    expect(fastTextSlotLaunch(CONTEXT_CAP, undefined)).toEqual({
      parallel: 1,
      contextSize: 16_384,
    });
  });
  it('K < 1 or non-finite clamps up to a single slot', () => {
    expect(fastTextSlotLaunch(CONTEXT_CAP, 0)).toEqual({ parallel: 1, contextSize: 16_384 });
    expect(fastTextSlotLaunch(CONTEXT_CAP, -5)).toEqual({ parallel: 1, contextSize: 16_384 });
    expect(fastTextSlotLaunch(CONTEXT_CAP, Number.NaN)).toEqual({
      parallel: 1,
      contextSize: 16_384,
    });
  });
});

describe('supervisor arg construction — parallel slots, full per-slot context', () => {
  it('parallel=3 → args include --parallel 3 AND -c 49152', () => {
    const args = corpFastTextArgs(3);
    expect(valueAfter(args, '--parallel')).toBe('3');
    expect(valueAfter(args, '-c')).toBe('49152');
  });

  it('parallel=1 → args include --parallel 1 AND -c 16384', () => {
    const args = corpFastTextArgs(1);
    expect(valueAfter(args, '--parallel')).toBe('1');
    expect(valueAfter(args, '-c')).toBe('16384');
  });

  it('parallel unset → --parallel 1 AND -c 16384 (default single-slot launch)', () => {
    const args = corpFastTextArgs(undefined);
    expect(valueAfter(args, '--parallel')).toBe('1');
    expect(valueAfter(args, '-c')).toBe('16384');
  });

  it('KEEPS MTP spec-decode + model/host/port args when slicing into K slots', () => {
    const args = corpFastTextArgs(3);
    // Fast-text speculative decoding is untouched by the extra slots.
    expect(args).toContain('--spec-type');
    expect(args).toContain('draft-mtp');
    // Core launch args stay identical.
    expect(valueAfter(args, '-m')).toBe('/models/qwen.gguf');
    expect(valueAfter(args, '--host')).toBe('127.0.0.1');
    expect(valueAfter(args, '--port')).toBe('8080');
    // Never a vision projector on a fast-text launch (MTP ⊥ mmproj).
    expect(args).not.toContain('--mmproj');
  });
});
