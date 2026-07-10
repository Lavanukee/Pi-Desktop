import { describe, expect, it, vi } from 'vitest';
import {
  DownloadCancellation,
  discardPartials,
  type PartialFile,
  partialPaths,
} from './download-cancellation';

const join = (dir: string, name: string) => `${dir}/${name}`;
const files: PartialFile[] = [
  { name: 'model-Q4.gguf', quant: 'Q4_K_M' },
  { name: 'model-Q6.gguf', quant: 'Q6_K' },
];

describe('DownloadCancellation', () => {
  it('begins a download and exposes a live abort signal', () => {
    const c = new DownloadCancellation();
    expect(c.running).toBe(false);
    expect(c.intent).toBe(null);
    const signal = c.begin();
    expect(signal.aborted).toBe(false);
    expect(c.running).toBe(true);
    expect(c.intent).toBe(null);
  });

  it('cancel aborts the in-flight signal and records the cancel intent', () => {
    const c = new DownloadCancellation();
    const signal = c.begin();
    expect(c.cancel()).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(c.intent).toBe('cancel');
  });

  it('pause aborts the signal but records the pause intent (keep the .part)', () => {
    const c = new DownloadCancellation();
    const signal = c.begin();
    expect(c.pause()).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(c.intent).toBe('pause');
  });

  it('pause/cancel are no-ops (false) when nothing is running', () => {
    const c = new DownloadCancellation();
    expect(c.cancel()).toBe(false);
    expect(c.pause()).toBe(false);
    expect(c.running).toBe(false);
  });

  it('refuses to begin a second concurrent download', () => {
    const c = new DownloadCancellation();
    c.begin();
    expect(() => c.begin()).toThrow(/already running/);
  });

  it('clear() resets so the next download starts fresh', () => {
    const c = new DownloadCancellation();
    const first = c.begin();
    c.cancel();
    c.clear();
    expect(c.running).toBe(false);
    expect(c.intent).toBe(null);
    const second = c.begin();
    expect(second).not.toBe(first);
    expect(second.aborted).toBe(false);
  });
});

describe('partialPaths', () => {
  it('returns a .part sidecar for every file when no quant is given', () => {
    expect(partialPaths('/models/m', files, undefined, join)).toEqual([
      '/models/m/model-Q4.gguf.part',
      '/models/m/model-Q6.gguf.part',
    ]);
  });

  it('filters to the matching quant when one is given', () => {
    expect(partialPaths('/models/m', files, 'Q6_K', join)).toEqual([
      '/models/m/model-Q6.gguf.part',
    ]);
  });

  it('yields nothing for an unknown quant', () => {
    expect(partialPaths('/models/m', files, 'Q8_0', join)).toEqual([]);
  });
});

describe('discardPartials', () => {
  it('unlinks every provided .part path', async () => {
    const unlink = vi.fn(async (_p: string) => {});
    await discardPartials(['/m/a.part', '/m/b.part'], unlink);
    expect(unlink.mock.calls.map((c) => c[0])).toEqual(['/m/a.part', '/m/b.part']);
  });

  it('tolerates an already-absent .part (a rejecting unlink does not throw)', async () => {
    const unlink = vi.fn(async (p: string) => {
      if (p.includes('missing')) throw new Error('ENOENT');
    });
    await expect(
      discardPartials(['/m/missing.part', '/m/present.part'], unlink),
    ).resolves.toBeUndefined();
    // Cleanup continues past the missing one.
    expect(unlink).toHaveBeenCalledTimes(2);
  });
});
