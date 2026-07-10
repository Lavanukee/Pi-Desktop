import { describe, expect, it } from 'vitest';
import { recommend } from './recommender.js';

describe('recommend (speed-optimized budget tiers)', () => {
  it('8GB → Qwen3.5-4B MTP, fast-text', () => {
    const r = recommend({ totalRamGB: 8 });
    expect(r.tier).toBe('8GB');
    expect(r.model.id).toBe('qwen3.5-4b-mtp');
    expect(r.file.quant).toBe('Q4_K_M');
    expect(r.launchMode).toBe('fast-text');
    expect(r.model.spec).toBe('mtp');
  });

  it('16GB → Gemma4-12B MTP (vision-capable), fast-text', () => {
    const r = recommend({ totalRamGB: 16 });
    expect(r.tier).toBe('16GB');
    expect(r.model.id).toBe('gemma-4-12b-it');
    expect(r.model.spec).toBe('mtp');
  });

  it('24GB → Qwen3.6-27B MTP Q4_K_M', () => {
    const r = recommend({ totalRamGB: 24 });
    expect(r.tier).toBe('24GB');
    expect(r.model.id).toBe('qwen3.6-27b-mtp');
    expect(r.file.quant).toBe('Q4_K_M');
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

  it('below 8GB → Gemma4-E2B (MTP) as the fast primary', () => {
    const r = recommend({ totalRamGB: 6 });
    expect(r.tier).toBe('<8GB');
    expect(r.model.id).toBe('gemma-4-e2b-it');
    expect(r.model.spec).toBe('mtp');
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
      expect(r.utilityModel.id).toBe('gemma-4-e2b-it');
      expect(r.utilityFile.quant).toBe('Q4_K_M');
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

  it('respects the exact tier boundaries', () => {
    expect(recommend({ totalRamGB: 47 }).tier).toBe('32GB');
    expect(recommend({ totalRamGB: 48 }).tier).toBe('48GB');
    expect(recommend({ totalRamGB: 23 }).tier).toBe('16GB');
    expect(recommend({ totalRamGB: 24 }).tier).toBe('24GB');
    expect(recommend({ totalRamGB: 7 }).tier).toBe('<8GB');
  });
});
