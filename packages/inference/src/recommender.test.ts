import { describe, expect, it } from 'vitest';
import { getCatalogModel, MODEL_TIERS } from './catalog.js';
import { recommend, resolveTierModels, tierDisplayName } from './recommender.js';

describe('recommend (speed-optimized budget tiers)', () => {
  it('8GB → Qwen3.5-4B MTP, fast-text, Q8_0 (sub-12B never Q4)', () => {
    const r = recommend({ totalRamGB: 8 });
    expect(r.tier).toBe('8GB');
    expect(r.model.id).toBe('qwen3.5-4b-mtp');
    // Sub-12B quant policy: Q8_0 default (4B ≈ 4.3GB fits 8GB with headroom).
    expect(r.file.quant).toBe('Q8_0');
    expect(r.launchMode).toBe('fast-text');
    expect(r.model.spec).toBe('mtp');
  });

  it('16GB → steps down to the 8GB-tier Qwen3.5-4B to keep headroom (12B needs 16)', () => {
    // The 16GB-tier default (Gemma4-12B) needs ~16GB — exactly the machine total,
    // no headroom — so recommend() drops to the lighter 8GB-tier speed pick.
    const r = recommend({ totalRamGB: 16 });
    expect(r.tier).toBe('8GB');
    expect(r.model.id).toBe('qwen3.5-4b-mtp');
    expect(r.model.spec).toBe('mtp');
    expect(r.model.minRamGB).toBeLessThan(16);
  });

  it('24GB → steps down to the 16GB-tier Gemma4-12B (never the exact-fit 27B)', () => {
    // The 27B needs ~24GB (= the machine total), so it is NOT the DEFAULT pick;
    // the headroom step-down lands on the vision-capable 12B instead.
    const r = recommend({ totalRamGB: 24 });
    expect(r.tier).toBe('16GB');
    expect(r.model.id).toBe('gemma-4-12b-it');
    expect(r.model.id).not.toBe('qwen3.6-27b-mtp');
    expect(r.file.quant).toBe('Q4_K_M');
    expect(r.model.minRamGB).toBeLessThan(24);
  });

  it('leaves headroom at every tier — no default recommends a model needing ≥ total RAM', () => {
    for (const ram of [6, 8, 16, 24, 32, 48, 64, 96, 128]) {
      const r = recommend({ totalRamGB: ram });
      // A tiny (<8GB) machine is the one exception: nothing lighter exists.
      if (ram >= 8) expect(r.model.minRamGB, `${ram}GB recommends ${r.model.id}`).toBeLessThan(ram);
      for (const pick of r.simpleSet) {
        if (ram >= 8) expect(pick.model.minRamGB).toBeLessThan(ram);
      }
    }
  });

  it('32GB → Qwen3.6-35B-A3B MoE MTP (UD-Q4_K_M)', () => {
    const r = recommend({ totalRamGB: 32 });
    expect(r.tier).toBe('32GB');
    expect(r.model.id).toBe('qwen3.6-35b-a3b-mtp');
    expect(r.file.quant).toBe('UD-Q4_K_M');
  });

  it('48 / 64 / 96 / 128GB → Qwen3.6-35B-A3B MoE MTP (UD-Q6_K)', () => {
    for (const [ram, tier] of [
      [48, '48GB'],
      [64, '64GB'],
      [96, '96GB'],
      [128, '128GB'],
    ] as const) {
      const r = recommend({ totalRamGB: ram });
      expect(r.tier).toBe(tier);
      expect(r.model.id).toBe('qwen3.6-35b-a3b-mtp');
      expect(r.file.quant).toBe('UD-Q6_K');
    }
  });

  it('below 8GB → falls back to the effective-2B Gemma-4 E2B (never the 4B worker)', () => {
    // A sub-8GB Mac can't run the 4B Qwen worker responsively, so the default
    // recommendation drops to the lighter Gemma-4 E2B — the low-end user is
    // never locked out. Still a real spec-decode (MTP) fast-text launch.
    const r = recommend({ totalRamGB: 6 });
    expect(r.tier).toBe('<8GB');
    expect(r.model.id).toBe('gemma-4-e2b-it');
    expect(r.model.id).not.toBe('qwen3.5-4b-mtp');
    // Sub-12B never Q4: Q8 (~5GB) will not fit a <8GB machine, so the recommender
    // drops to the dynamic Q6 floor (UD-Q6_K_XL), not Q4.
    expect(r.file.quant).toBe('UD-Q6_K_XL');
    expect(r.launchMode).toBe('fast-text');
    expect(r.model.spec).toBe('mtp');
  });

  it('8GB is the Qwen/Gemma capability floor: 7GB → Gemma E2B, 8GB → Qwen 4B', () => {
    // The threshold is the <8GB / 8GB tier boundary: below it the machine is too
    // weak for the 4B default; at 8GB+ Qwen3.5-4B (headroom: needs ~6GB) is back.
    expect(recommend({ totalRamGB: 7 }).model.id).toBe('gemma-4-e2b-it');
    expect(recommend({ totalRamGB: 8 }).model.id).toBe('qwen3.5-4b-mtp');
  });

  it('every primary pick runs a real spec-decode method', () => {
    for (const ram of [6, 8, 16, 24, 32, 48, 64, 96, 128]) {
      const r = recommend({ totalRamGB: ram });
      expect(r.launchMode).toBe('fast-text');
      expect(r.model.spec === 'mtp' || r.model.spec === 'eagle3').toBe(true);
    }
  });

  it('always includes the small utility slot with a rationale', () => {
    for (const ram of [8, 16, 24, 32, 48, 64, 96, 128]) {
      const r = recommend({ totalRamGB: ram });
      expect(r.utilityModel.id).toBe('qwen3.5-4b-mtp');
      // Sub-12B utility slot: Q8_0 default (never Q4); ram≥8 always leaves headroom.
      expect(r.utilityFile.quant).toBe('Q8_0');
      expect(r.rationale).toContain(String(ram));
    }
  });

  describe('simpleSet (Recommended for your Mac)', () => {
    it('is 1–3 de-duplicated picks led by the speed pick', () => {
      for (const ram of [6, 8, 16, 24, 32, 48, 64, 128]) {
        const r = recommend({ totalRamGB: ram });
        expect(r.simpleSet.length).toBeGreaterThanOrEqual(1);
        expect(r.simpleSet.length).toBeLessThanOrEqual(3);
        expect(r.simpleSet[0]?.role).toBe('speed');
        expect(r.simpleSet[0]?.model.id).toBe(r.model.id);
        const ids = r.simpleSet.map((p) => p.model.id);
        expect(new Set(ids).size).toBe(ids.length); // no dupes
      }
    });

    it('offers a vision pick + the lightweight helper at a mid tier', () => {
      const r = recommend({ totalRamGB: 32 });
      const roles = r.simpleSet.map((p) => p.role);
      expect(roles).toContain('vision');
      expect(roles).toContain('utility');
      const vision = r.simpleSet.find((p) => p.role === 'vision');
      expect(vision?.vision).toBe(true);
      expect(vision?.launchMode).toBe('multimodal');
    });

    it('the speed pick carries its spec method; a vision (multimodal) pick does not', () => {
      const r = recommend({ totalRamGB: 24 });
      expect(r.simpleSet[0]?.spec).toBe('mtp');
      const vision = r.simpleSet.find((p) => p.role === 'vision');
      expect(vision?.spec).toBeUndefined();
    });
  });

  it('respects the tier boundaries after the headroom step-down', () => {
    expect(recommend({ totalRamGB: 47 }).tier).toBe('32GB');
    expect(recommend({ totalRamGB: 48 }).tier).toBe('48GB');
    expect(recommend({ totalRamGB: 23 }).tier).toBe('16GB');
    // 24GB steps down from the nominal 24GB tier (exact-fit 27B) to 16GB.
    expect(recommend({ totalRamGB: 24 }).tier).toBe('16GB');
    expect(recommend({ totalRamGB: 7 }).tier).toBe('<8GB');
  });
});

describe('resolveTierModels (per-hardware 3-tier resolution)', () => {
  it('resolves all three tiers for every RAM tier, referencing real catalog files', () => {
    for (const ram of [6, 8, 16, 24, 32, 48, 64, 96, 128]) {
      const picks = resolveTierModels({ totalRamGB: ram });
      for (const tier of MODEL_TIERS) {
        const p = picks[tier];
        expect(p.tier).toBe(tier);
        // The pick references a catalog model + one of its quants.
        const m = getCatalogModel(p.model.id);
        expect(m).toBeDefined();
        expect(m?.files.some((f) => f.quant === p.file.quant)).toBe(true);
        expect(p.launchMode).toBe('fast-text');
        expect(typeof p.vision).toBe('boolean');
        expect(p.displayName.length).toBeGreaterThan(0);
      }
    }
  });

  it('the dev M5 Pro 24GB resolves fast=qwen3.5-4b, balanced=gemma-12b (vision), intelligent=qwen3.6-27b', () => {
    const p = resolveTierModels({ totalRamGB: 24 });
    expect(p.fast.model.id).toBe('qwen3.5-4b-mtp');
    // Sub-12B fast pick: Q8_0 default (fits 24GB easily); >=12B tiers keep Q4_K_M.
    expect(p.fast.file.quant).toBe('Q8_0');
    expect(p.balanced.model.id).toBe('gemma-4-12b-it');
    expect(p.balanced.vision).toBe(true);
    expect(p.intelligent.model.id).toBe('qwen3.6-27b-mtp');
    expect(p.intelligent.file.quant).toBe('Q4_K_M');
    expect(p.intelligent.spec).toBe('mtp');
  });

  it('follows the round-12 resolution table across the RAM tiers', () => {
    const id = (ram: number) => {
      const p = resolveTierModels({ totalRamGB: ram });
      return {
        fast: p.fast.model.id,
        balanced: p.balanced.model.id,
        intel: p.intelligent.model.id,
      };
    };
    expect(id(6)).toEqual({
      fast: 'qwen3.5-4b-mtp',
      balanced: 'qwen3.5-4b-mtp',
      intel: 'gemma-4-e4b-it',
    });
    expect(id(8)).toEqual({
      fast: 'qwen3.5-4b-mtp',
      balanced: 'gemma-4-e4b-it',
      intel: 'gemma-4-12b-it',
    });
    expect(id(16)).toEqual({
      fast: 'qwen3.5-4b-mtp',
      balanced: 'gemma-4-12b-it',
      intel: 'gemma-4-12b-it',
    });
    expect(id(32)).toEqual({
      fast: 'qwen3.5-4b-mtp',
      balanced: 'gemma-4-12b-it',
      intel: 'qwen3.6-35b-a3b-mtp',
    });
    expect(id(64)).toEqual({
      fast: 'qwen3.5-9b-mtp',
      balanced: 'gemma-4-26b-a4b-it',
      intel: 'qwen3.6-35b-a3b-mtp',
    });
  });

  it('is deterministic (same input → identical resolution)', () => {
    expect(resolveTierModels({ totalRamGB: 24 })).toEqual(resolveTierModels({ totalRamGB: 24 }));
  });

  it('a tiny machine dedups two tiers onto the same model id', () => {
    const p = resolveTierModels({ totalRamGB: 6 });
    expect(p.fast.model.id).toBe(p.balanced.model.id); // both qwen3.5-4b-mtp at <8GB
  });
});

describe('tierDisplayName', () => {
  it('condenses the display name to the grey dropdown label', () => {
    expect(tierDisplayName(getCatalogModel('gemma-4-e2b-it') as never)).toBe('gemma4 e2b');
    expect(tierDisplayName(getCatalogModel('gemma-4-12b-it') as never)).toBe('gemma4 12b');
    expect(tierDisplayName(getCatalogModel('qwen3.6-27b-mtp') as never)).toBe('qwen3.6 27b');
  });
});
