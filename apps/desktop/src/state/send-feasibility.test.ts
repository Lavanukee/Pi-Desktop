/**
 * Send-feasibility estimator: the RAM math + reason classification that decides
 * whether a pending chat send runs now, waits for the current reply, waits for a
 * model swap, or likely won't fit at all. Pure — no electron, no llama-server.
 *
 * A parity block pins the local RAM constants to the corp KV-slot estimator
 * (electron/corp/concurrency.ts) so the two OOM models can never silently drift.
 */
import { describe, expect, it } from 'vitest';
import {
  CORP_RESERVE_BYTES,
  CORP_USABLE_FRACTION,
  QWEN_CORP_PER_SLOT_KV_BYTES,
} from '../../electron/corp/concurrency';
import {
  assessSendFeasibility,
  type CatalogEntryLike,
  PER_SLOT_KV_BYTES,
  RESERVE_BYTES,
  resolveTargetModel,
  targetFits,
  USABLE_FRACTION,
} from './send-feasibility';

const GiB = 1024 ** 3;
const model = (id: string, weightsGB: number, minRamGB?: number) => ({
  modelId: id,
  displayName: id,
  weightsBytes: Math.round(weightsGB * GiB),
  minRamGB,
});

describe('parity with the corp KV-slot estimator', () => {
  it('shares the same usable fraction, reserve, and per-slot KV budget', () => {
    expect(USABLE_FRACTION).toBe(CORP_USABLE_FRACTION);
    expect(RESERVE_BYTES).toBe(CORP_RESERVE_BYTES);
    expect(PER_SLOT_KV_BYTES).toBe(QWEN_CORP_PER_SLOT_KV_BYTES);
  });
});

describe('targetFits', () => {
  it('a small model fits a modest machine', () => {
    // 16 GB → usable 12; a 4.6 GB model + 2 GB reserve leaves ~5.4 GB > 0.8 slot.
    expect(targetFits(16, model('qwen-4b', 4.6))).toBe(true);
  });

  it('a huge model does not fit a small machine', () => {
    // 8 GB → usable 6; an 18 GB model can't even hold its weights.
    expect(targetFits(8, model('big-31b', 18))).toBe(false);
  });

  it('falls back to the minRamGB gate when weight bytes are unknown', () => {
    expect(targetFits(16, { modelId: 'x', displayName: 'x', weightsBytes: 0, minRamGB: 24 })).toBe(
      false,
    );
    expect(targetFits(32, { modelId: 'x', displayName: 'x', weightsBytes: 0, minRamGB: 24 })).toBe(
      true,
    );
  });

  it('assumes it fits when nothing is known (never a fabricated OOM warning)', () => {
    expect(targetFits(16, { modelId: 'x', displayName: 'x', weightsBytes: 0 })).toBe(true);
    expect(targetFits(16, null)).toBe(true);
  });

  it('a non-positive RAM reading is treated as unknown → fits', () => {
    expect(targetFits(0, model('big', 18))).toBe(true);
    expect(targetFits(Number.NaN, model('big', 18))).toBe(true);
  });
});

describe('assessSendFeasibility', () => {
  const base = { totalRamGB: 16, loadedModelId: 'loaded', loadedModelName: 'Loaded' };

  it('ready when idle and the model fits', () => {
    const r = assessSendFeasibility({
      ...base,
      target: model('loaded', 4.6),
      turnInFlight: false,
    });
    expect(r.kind).toBe('ready');
    expect(r.targetFits).toBe(true);
  });

  it('insufficient-ram wins even while a turn is in flight', () => {
    const r = assessSendFeasibility({
      totalRamGB: 8,
      loadedModelId: 'loaded',
      loadedModelName: 'Loaded',
      target: model('big-31b', 18),
      turnInFlight: true,
    });
    expect(r.kind).toBe('insufficient-ram');
  });

  it('busy-same-model when a turn runs on the same model', () => {
    const r = assessSendFeasibility({
      ...base,
      target: model('loaded', 4.6),
      turnInFlight: true,
    });
    expect(r.kind).toBe('busy-same-model');
  });

  it('busy-switch-model when a turn runs but a different model is selected', () => {
    const r = assessSendFeasibility({
      ...base,
      target: model('other', 7),
      turnInFlight: true,
    });
    expect(r.kind).toBe('busy-switch-model');
  });

  it('unknown target (Auto, pre-classify) waits as same-model, not a swap', () => {
    const r = assessSendFeasibility({
      ...base,
      target: null,
      turnInFlight: true,
    });
    expect(r.kind).toBe('busy-same-model');
  });

  it('reports the RAM basis (usable/available) for the modal copy', () => {
    const r = assessSendFeasibility({
      ...base,
      target: model('loaded', 4.6),
      turnInFlight: false,
    });
    expect(r.usableGB).toBeCloseTo(12, 5);
    // usable 12 − 4.6 weights − 2 reserve ≈ 5.4
    expect(r.availableGB).toBeCloseTo(5.4, 1);
  });
});

describe('resolveTargetModel', () => {
  const catalog: CatalogEntryLike[] = [
    {
      id: 'qwen-4b',
      displayName: 'Qwen 4B',
      minRamGB: 6,
      quants: [{ quant: 'Q8_0', bytes: Math.round(4.6 * GiB) }],
    },
    {
      id: 'gemma-12b',
      displayName: 'Gemma 12B',
      minRamGB: 16,
      quants: [
        { quant: 'Q4_K_M', bytes: Math.round(7.1 * GiB) },
        { quant: 'Q8_0', bytes: Math.round(12 * GiB) },
      ],
    },
  ];
  const loaded = { id: 'qwen-4b', displayName: 'Qwen 4B', quant: 'Q8_0' };

  it('auto → the loaded model (best guess)', () => {
    const t = resolveTargetModel({ selection: { mode: 'auto' }, catalog, loaded });
    expect(t?.modelId).toBe('qwen-4b');
    expect(t?.weightsBytes).toBe(Math.round(4.6 * GiB));
  });

  it('auto with nothing loaded → unknown (null)', () => {
    const t = resolveTargetModel({ selection: { mode: 'auto' }, catalog, loaded: null });
    expect(t).toBeNull();
  });

  it('tier → the machine pick, enriched with the catalog minRamGB', () => {
    const t = resolveTargetModel({
      selection: { mode: 'tier', tier: 'balanced' },
      tierModels: {
        balanced: { modelId: 'gemma-12b', displayName: 'Gemma 12B', bytes: Math.round(7.1 * GiB) },
      },
      catalog,
      loaded,
    });
    expect(t?.modelId).toBe('gemma-12b');
    expect(t?.weightsBytes).toBe(Math.round(7.1 * GiB));
    expect(t?.minRamGB).toBe(16);
  });

  it('explicit model → the catalog entry, using its largest quant as the RAM bound', () => {
    const t = resolveTargetModel({
      selection: { mode: 'model', modelId: 'gemma-12b' },
      catalog,
      loaded,
    });
    expect(t?.modelId).toBe('gemma-12b');
    expect(t?.weightsBytes).toBe(Math.round(12 * GiB));
  });

  it('an unknown explicit model id → null', () => {
    const t = resolveTargetModel({
      selection: { mode: 'model', modelId: 'nope' },
      catalog,
      loaded,
    });
    expect(t).toBeNull();
  });
});
