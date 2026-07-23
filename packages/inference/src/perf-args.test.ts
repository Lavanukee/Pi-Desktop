import { describe, expect, it } from 'vitest';
import { chooseServerPerfArgs, MEMORY_PRESSURE_FRACTION } from './perf-args.js';

/** Qwen3.5-4B-Q8_0 real gguf size — the fast-load model used in the live benches. */
const QWEN4B_Q8_BYTES = 4_610_580_800;

describe('chooseServerPerfArgs', () => {
  it('apple silicon with RAM headroom adds NOTHING (auto is measured-optimal)', () => {
    // 4B on 24GB M-series: footprint ~6GB << 80% of 24GB. This is the common case.
    const r = chooseServerPerfArgs({
      isAppleSilicon: true,
      totalRamGB: 24,
      modelBytes: QWEN4B_Q8_BYTES,
      contextSize: 16_384,
      cpuCount: 15,
    });
    expect(r.args).toEqual([]);
    expect(r.rationale.join(' ')).toMatch(/headroom/i);
  });

  it('apple silicon under memory pressure falls back to q8_0 KV + flash-attn', () => {
    // A ~20GB-weights model on a 16GB machine → footprint > 80% of RAM.
    const r = chooseServerPerfArgs({
      isAppleSilicon: true,
      totalRamGB: 16,
      modelBytes: 20 * 1024 ** 3,
      contextSize: 16_384,
    });
    expect(r.args).toEqual(['-fa', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0']);
    expect(r.rationale.join(' ')).toMatch(/pressure/i);
  });

  it('never forces -ngl (offload stays auto) on either platform', () => {
    const metal = chooseServerPerfArgs({
      isAppleSilicon: true,
      totalRamGB: 16,
      modelBytes: 20 * 1024 ** 3,
      contextSize: 16_384,
    });
    const cuda = chooseServerPerfArgs({
      isAppleSilicon: false,
      totalRamGB: 24,
      modelBytes: QWEN4B_Q8_BYTES,
      contextSize: 8192,
    });
    expect(metal.args).not.toContain('-ngl');
    expect(metal.args).not.toContain('--n-gpu-layers');
    expect(cuda.args).not.toContain('-ngl');
    expect(cuda.args).not.toContain('--n-gpu-layers');
  });

  it('never enables q8_0 KV when there is headroom (measured 6-8% slower than f16)', () => {
    const r = chooseServerPerfArgs({
      isAppleSilicon: true,
      totalRamGB: 64,
      modelBytes: QWEN4B_Q8_BYTES,
      contextSize: 16_384,
    });
    expect(r.args).not.toContain('--cache-type-k');
    expect(r.args).not.toContain('q8_0');
  });

  it('non-apple-silicon (discrete GPU) turns flash-attn on with auto offload', () => {
    const r = chooseServerPerfArgs({
      isAppleSilicon: false,
      totalRamGB: 24,
      modelBytes: QWEN4B_Q8_BYTES,
      contextSize: 8192,
    });
    expect(r.args).toEqual(['-fa', 'on']);
    expect(r.rationale.join(' ')).toMatch(/discrete GPU/i);
  });

  it('non-apple-silicon under pressure also adds q8_0 KV', () => {
    const r = chooseServerPerfArgs({
      isAppleSilicon: false,
      totalRamGB: 8,
      modelBytes: 12 * 1024 ** 3,
      contextSize: 8192,
    });
    expect(r.args).toEqual(['-fa', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0']);
  });

  it('unknown RAM (0) never reports pressure (guards against a bad divide)', () => {
    const r = chooseServerPerfArgs({
      isAppleSilicon: true,
      totalRamGB: 0,
      modelBytes: 20 * 1024 ** 3,
      contextSize: 16_384,
    });
    expect(r.args).toEqual([]);
  });

  it('MEMORY_PRESSURE_FRACTION leaves OS/compute headroom (0 < f < 1)', () => {
    expect(MEMORY_PRESSURE_FRACTION).toBeGreaterThan(0);
    expect(MEMORY_PRESSURE_FRACTION).toBeLessThan(1);
  });
});
