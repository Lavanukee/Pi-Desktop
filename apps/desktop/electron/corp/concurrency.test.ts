import { describe, expect, it } from 'vitest';
import {
  CORP_MAX_CONCURRENCY,
  corpConcurrencyBasis,
  corpConcurrencyForHost,
  type PickCorpConcurrencyInput,
  pickCorpConcurrency,
  QWEN_CORP_MODEL_WEIGHTS_BYTES,
  QWEN_CORP_PER_SLOT_KV_BYTES,
} from './concurrency';

const GiB = 1024 ** 3;

/** The qwen3.5-4b-mtp Q8 constants the host caller uses, for the pure function. */
const qwen = (totalRamBytes: number): PickCorpConcurrencyInput => ({
  totalRamBytes,
  modelWeightsBytes: QWEN_CORP_MODEL_WEIGHTS_BYTES,
  perSlotKvBytes: QWEN_CORP_PER_SLOT_KV_BYTES,
});

describe('pickCorpConcurrency — OOM-safe K selection', () => {
  it('8 GB machine → 1 (sequential): no headroom for even one extra slot', () => {
    // usable 6 GiB − weights 4.6 GB − reserve 2 GB < 0 → sequential.
    expect(pickCorpConcurrency(qwen(8 * GiB))).toBe(1);
  });

  it('16 GB machine → 2–3 concurrent engineers', () => {
    const k = pickCorpConcurrency(qwen(16 * GiB));
    expect(k).toBeGreaterThanOrEqual(2);
    expect(k).toBeLessThanOrEqual(3);
  });

  it('32 GB machine → capped at maxK (3)', () => {
    expect(pickCorpConcurrency(qwen(32 * GiB))).toBe(CORP_MAX_CONCURRENCY);
  });

  it('64 GB machine → still capped at maxK (3), never higher', () => {
    expect(pickCorpConcurrency(qwen(64 * GiB))).toBe(CORP_MAX_CONCURRENCY);
  });

  it('follows the documented formula floor(available / perSlotKv), clamped', () => {
    // Hand-computed: usable = 24 GiB, available = 24 GiB − weights − 2 GiB.
    const totalRamBytes = 32 * GiB;
    const usable = totalRamBytes * 0.75;
    const available = usable - QWEN_CORP_MODEL_WEIGHTS_BYTES - 2 * GiB;
    const expected = Math.max(
      1,
      Math.min(CORP_MAX_CONCURRENCY, Math.floor(available / QWEN_CORP_PER_SLOT_KV_BYTES)),
    );
    expect(pickCorpConcurrency(qwen(totalRamBytes))).toBe(expected);
  });

  describe('sequential-by-default on every degenerate input', () => {
    it('NaN total RAM → 1', () => {
      expect(pickCorpConcurrency(qwen(Number.NaN))).toBe(1);
    });
    it('Infinity total RAM → 1 (non-finite available)', () => {
      expect(pickCorpConcurrency(qwen(Number.POSITIVE_INFINITY))).toBe(1);
    });
    it('zero total RAM → 1', () => {
      expect(pickCorpConcurrency(qwen(0))).toBe(1);
    });
    it('negative total RAM → 1', () => {
      expect(pickCorpConcurrency(qwen(-16 * GiB))).toBe(1);
    });
    it('tiny total RAM (1 GB) → 1', () => {
      expect(pickCorpConcurrency(qwen(1 * GiB))).toBe(1);
    });
    it('per-slot KV of 0 → 1 (no division-by-zero blow-up)', () => {
      expect(
        pickCorpConcurrency({
          totalRamBytes: 64 * GiB,
          modelWeightsBytes: QWEN_CORP_MODEL_WEIGHTS_BYTES,
          perSlotKvBytes: 0,
        }),
      ).toBe(1);
    });
    it('non-finite per-slot KV → 1', () => {
      expect(
        pickCorpConcurrency({
          totalRamBytes: 64 * GiB,
          modelWeightsBytes: QWEN_CORP_MODEL_WEIGHTS_BYTES,
          perSlotKvBytes: Number.NaN,
        }),
      ).toBe(1);
    });
    it('weights larger than usable RAM → 1', () => {
      expect(
        pickCorpConcurrency({
          totalRamBytes: 16 * GiB,
          modelWeightsBytes: 100 * GiB,
          perSlotKvBytes: QWEN_CORP_PER_SLOT_KV_BYTES,
        }),
      ).toBe(1);
    });
  });

  it('K is ALWAYS an integer in [1, maxK] across a wide RAM sweep', () => {
    for (let gb = 1; gb <= 256; gb += 1) {
      const k = pickCorpConcurrency(qwen(gb * GiB));
      expect(Number.isInteger(k)).toBe(true);
      expect(k).toBeGreaterThanOrEqual(1);
      expect(k).toBeLessThanOrEqual(CORP_MAX_CONCURRENCY);
    }
  });

  it('honours a custom maxK ceiling', () => {
    expect(pickCorpConcurrency({ ...qwen(256 * GiB), maxK: 5 })).toBe(5);
    expect(pickCorpConcurrency({ ...qwen(256 * GiB), maxK: 1 })).toBe(1);
  });

  it('a smaller reserve frees headroom for more slots', () => {
    const tight = pickCorpConcurrency({ ...qwen(16 * GiB), reserveBytes: 8 * GiB });
    const loose = pickCorpConcurrency({ ...qwen(16 * GiB), reserveBytes: 0 });
    expect(loose).toBeGreaterThanOrEqual(tight);
  });
});

describe('corpConcurrencyBasis — reports the RAM basis alongside K', () => {
  it('returns the usable/available figures used to derive K', () => {
    const basis = corpConcurrencyBasis(qwen(32 * GiB));
    expect(basis.usableBytes).toBe(32 * GiB * 0.75);
    expect(basis.availableBytes).toBe(32 * GiB * 0.75 - QWEN_CORP_MODEL_WEIGHTS_BYTES - 2 * GiB);
    expect(basis.concurrency).toBe(pickCorpConcurrency(qwen(32 * GiB)));
    expect(basis.maxK).toBe(CORP_MAX_CONCURRENCY);
  });
});

describe('corpConcurrencyForHost — injectable total RAM', () => {
  it('applies the qwen constants and returns an in-range K', () => {
    const basis = corpConcurrencyForHost(16 * GiB);
    expect(basis.modelWeightsBytes).toBe(QWEN_CORP_MODEL_WEIGHTS_BYTES);
    expect(basis.perSlotKvBytes).toBe(QWEN_CORP_PER_SLOT_KV_BYTES);
    expect(basis.concurrency).toBeGreaterThanOrEqual(1);
    expect(basis.concurrency).toBeLessThanOrEqual(CORP_MAX_CONCURRENCY);
  });

  it('reads os.totalmem() by default and yields a valid K for this machine', () => {
    const basis = corpConcurrencyForHost();
    expect(Number.isInteger(basis.concurrency)).toBe(true);
    expect(basis.concurrency).toBeGreaterThanOrEqual(1);
    expect(basis.concurrency).toBeLessThanOrEqual(CORP_MAX_CONCURRENCY);
    expect(basis.totalRamBytes).toBeGreaterThan(0);
  });
});
