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
    expect(m?.spec).toBe('mtp');
    expect(getCatalogModel('qwen3.6-35b-a3b-mtp')?.mtpEmbedded).toBe(true);
    expect(getCatalogModel('qwen3.6-35b-a3b-mtp')?.hfRepo).toBe('unsloth/Qwen3.6-35B-A3B-MTP-GGUF');
  });

  it('carries the round-11 speed variants across the 8→128GB tiers', () => {
    const ids = CATALOG.map((m) => m.id);
    for (const id of [
      'qwen3.5-4b-mtp',
      'qwen3.5-9b-mtp',
      'gemma-4-26b-a4b-it',
      'gemma-4-31b-it',
      'qwen3.6-27b-eagle3',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('Qwen3.5 MTP entries embed the head (no sibling), Gemma4 uses a sibling file', () => {
    for (const id of ['qwen3.5-4b-mtp', 'qwen3.5-9b-mtp']) {
      const m = getCatalogModel(id);
      expect(m?.spec).toBe('mtp');
      expect(m?.mtpEmbedded).toBe(true);
      expect(m?.mtpFile).toBeUndefined();
    }
    // Gemma4 ships a separate Q8_0 MTP head sibling in the same repo.
    for (const id of ['gemma-4-e2b-it', 'gemma-4-e4b-it', 'gemma-4-12b-it', 'gemma-4-31b-it']) {
      const m = getCatalogModel(id);
      expect(m?.spec).toBe('mtp');
      expect(m?.mtpEmbedded).not.toBe(true);
      expect(m?.mtpFile?.name).toMatch(/^mtp-gemma-4-.*\.gguf$/);
      expect(m?.mtpFile?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('encodes the EAGLE-3 pairing: plain base + a draft from a separate repo', () => {
    const m = getCatalogModel('qwen3.6-27b-eagle3');
    expect(m?.spec).toBe('eagle3');
    expect(m?.hfRepo).toBe('unsloth/Qwen3.6-27B-GGUF'); // plain base, not the MTP repo
    expect(m?.mtpEmbedded).not.toBe(true);
    expect(m?.draftRepo).toBe('gelim/Qwen3.6-27B-PRISM-EAGLE3-GGUF');
    expect(m?.draftModel?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((m?.draftModel?.bytes ?? 0) > 0).toBe(true);
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
