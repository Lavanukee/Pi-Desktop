import { describe, expect, it } from 'vitest';
import { recommend } from './recommender.js';

describe('recommend (budget tiers)', () => {
  it('48GB+ → Qwen3.6-27B Q6_K, fast-text', () => {
    const r = recommend({ totalRamGB: 64 });
    expect(r.tier).toBe('48GB+');
    expect(r.model.id).toBe('qwen3.6-27b-mtp');
    expect(r.file.quant).toBe('Q6_K');
    expect(r.launchMode).toBe('fast-text');
  });

  it('32GB → Qwen3.6-27B Q4_K_M, fast-text', () => {
    const r = recommend({ totalRamGB: 32 });
    expect(r.tier).toBe('32GB');
    expect(r.model.id).toBe('qwen3.6-27b-mtp');
    expect(r.file.quant).toBe('Q4_K_M');
  });

  it('16GB → Gemma4-12B Q4_K_M', () => {
    const r = recommend({ totalRamGB: 16 });
    expect(r.tier).toBe('16GB');
    expect(r.model.id).toBe('gemma-4-12b-it');
    expect(r.file.quant).toBe('Q4_K_M');
  });

  it('below 16GB → utility model as primary', () => {
    const r = recommend({ totalRamGB: 8 });
    expect(r.tier).toBe('<16GB');
    expect(r.model.id).toBe('gemma-4-e2b-it');
  });

  it('always includes the small utility slot with a rationale', () => {
    for (const ram of [8, 16, 24, 32, 48, 64]) {
      const r = recommend({ totalRamGB: ram });
      expect(r.utilityModel.id).toBe('gemma-4-e2b-it');
      expect(r.utilityFile.quant).toBe('Q4_K_M');
      expect(r.rationale).toContain(String(ram));
    }
  });

  it('respects the exact 48GB boundary', () => {
    expect(recommend({ totalRamGB: 47 }).tier).toBe('32GB');
    expect(recommend({ totalRamGB: 48 }).tier).toBe('48GB+');
  });
});
