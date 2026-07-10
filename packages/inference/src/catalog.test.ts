import { describe, expect, it } from 'vitest';
import { CATALOG, GEMMA4_E2B, getCatalogFile, getCatalogModel, hfResolveUrl } from './catalog.js';

describe('catalog', () => {
  it('contains the required models (Gemma4 + Qwen3.6 MTP)', () => {
    const ids = CATALOG.map((m) => m.id);
    expect(ids).toContain('gemma-4-e2b-it');
    expect(ids).toContain('gemma-4-e4b-it');
    expect(ids).toContain('gemma-4-12b-it');
    expect(ids).toContain('qwen3.6-27b-mtp');
    expect(ids).toContain('qwen3.6-35b-a3b-mtp');
  });

  it('has an exact, verified Gemma4 E2B entry (the integration model)', () => {
    const m = getCatalogModel('gemma-4-e2b-it');
    expect(m).toBe(GEMMA4_E2B);
    expect(m?.verified).toBe(true);
    expect(m?.hfRepo).toBe('unsloth/gemma-4-E2B-it-GGUF');
    const q4 = getCatalogFile(GEMMA4_E2B, 'Q4_K_M');
    expect(q4?.name).toBe('gemma-4-E2B-it-Q4_K_M.gguf');
    expect(q4?.bytes).toBe(3_106_736_256);
  });

  it('points Qwen3.6-27B at the MTP repo with an embedded MTP head', () => {
    const m = getCatalogModel('qwen3.6-27b-mtp');
    expect(m?.hfRepo).toBe('unsloth/Qwen3.6-27B-MTP-GGUF');
    expect(m?.mtpEmbedded).toBe(true);
    expect(getCatalogModel('qwen3.6-35b-a3b-mtp')?.mtpEmbedded).toBe(true);
    expect(getCatalogModel('qwen3.6-35b-a3b-mtp')?.hfRepo).toBe('unsloth/Qwen3.6-35B-A3B-MTP-GGUF');
  });

  it('has the headline models HF-verified with non-zero, sha-backed bytes', () => {
    for (const id of ['qwen3.6-27b-mtp', 'gemma-4-e2b-it']) {
      const m = getCatalogModel(id);
      expect(m?.verified).toBe(true);
      expect(m?.files.length ?? 0).toBeGreaterThan(0);
      for (const f of m?.files ?? []) {
        expect(f.bytes).toBeGreaterThan(0);
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('has every catalog entry HF-verified (bytes>0, sha present) after re-verification', () => {
    for (const m of CATALOG) {
      expect(m.verified).toBe(true);
      for (const f of m.files) {
        expect(f.bytes).toBeGreaterThan(0);
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('builds HF resolve URLs', () => {
    expect(hfResolveUrl('unsloth/gemma-4-E2B-it-GGUF', 'gemma-4-E2B-it-Q4_K_M.gguf')).toBe(
      'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf',
    );
  });
});
