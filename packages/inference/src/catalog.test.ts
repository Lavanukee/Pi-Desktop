import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  GEMMA4_E2B,
  getCatalogFile,
  getCatalogModel,
  hfResolveUrl,
  isReliablePublisher,
  MLX_MODELS,
  MODEL_TIERS,
  modelEngine,
  RELIABLE_PUBLISHERS,
} from './catalog.js';

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

  it('every VERIFIED entry carries bytes>0 + a sha; reserved entries may be bytes:0', () => {
    for (const m of CATALOG) {
      if (m.verified) {
        for (const f of m.files) {
          expect(f.bytes).toBeGreaterThan(0);
          expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        }
      } else {
        // Reserved (not HEAD-verified) entries: no size assertion (bytes:0), no sha.
        for (const f of m.files) {
          expect(f.bytes).toBe(0);
          expect(f.sha256).toBeUndefined();
        }
      }
    }
  });

  // --- Round-12 expansion -----------------------------------------------------

  it('adds the round-12 models (Qwen3.5 0.8B/2B/122B + Nemotron-3)', () => {
    const ids = CATALOG.map((m) => m.id);
    for (const id of [
      'qwen3.5-0.8b-mtp',
      'qwen3.5-2b-mtp',
      'qwen3.5-122b-a10b-mtp',
      'nemotron-3-nano-30b-a3b',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('marks the 122B entry sharded and the Nemotron entry NVIDIA-licensed', () => {
    expect(getCatalogModel('qwen3.5-122b-a10b-mtp')?.sharded).toBe(true);
    const nemo = getCatalogModel('nemotron-3-nano-30b-a3b');
    expect(nemo?.license).toMatch(/NVIDIA/i);
    expect(nemo?.input).toEqual(['text']); // text-only
  });

  it('fixes the vision understatement: E2B + every Qwen -MTP ship mmproj + image input', () => {
    for (const id of [
      'gemma-4-e2b-it',
      'qwen3.5-0.8b-mtp',
      'qwen3.5-2b-mtp',
      'qwen3.5-4b-mtp',
      'qwen3.5-9b-mtp',
      'qwen3.6-27b-mtp',
      'qwen3.6-35b-a3b-mtp',
    ]) {
      const m = getCatalogModel(id);
      expect(m?.input).toContain('image');
      expect(m?.mmproj?.name).toBe('mmproj-F16.gguf');
    }
  });

  it('exposes DFlash as a shippable spec variant for the models that have a draft', () => {
    for (const id of [
      'gemma-4-12b-it',
      'gemma-4-26b-a4b-it',
      'gemma-4-31b-it',
      'qwen3.5-4b-mtp',
      'qwen3.5-9b-mtp',
      'qwen3.6-27b-mtp',
      'qwen3.6-35b-a3b-mtp',
    ]) {
      const dflash = getCatalogModel(id)?.variants?.find((v) => v.method === 'dflash');
      expect(dflash, id).toBeDefined();
      expect(dflash?.draftRepo).toBeTruthy();
    }
    // No DFlash draft exists for the <4B tier — MTP only.
    for (const id of ['gemma-4-e2b-it', 'qwen3.5-0.8b-mtp', 'qwen3.5-2b-mtp']) {
      const methods = getCatalogModel(id)?.variants?.map((v) => v.method) ?? [];
      expect(methods).toEqual(['mtp']);
    }
  });

  it('every entry has the new shape fields (engine, publisher, tier, valid variants)', () => {
    for (const m of CATALOG) {
      expect(['llamacpp', 'mlx']).toContain(modelEngine(m));
      expect(m.publisher?.handle).toBeTruthy();
      expect(m.publisher?.reliable).toBe(isReliablePublisher(m.publisher?.handle ?? ''));
      expect(MODEL_TIERS).toContain(m.tier);
      for (const v of m.variants ?? []) {
        expect(['mtp', 'eagle3', 'dflash']).toContain(v.method);
      }
    }
  });

  it('the reliable-publisher allowlist matches the round-12 handles', () => {
    expect(isReliablePublisher('unsloth')).toBe(true);
    expect(isReliablePublisher('Qwen')).toBe(true);
    expect(isReliablePublisher('mradermacher')).toBe(false); // community re-quanter
    expect(RELIABLE_PUBLISHERS).toContain('ggml-org');
    expect(RELIABLE_PUBLISHERS).not.toContain('ggml'); // bare ggml org does not exist
  });

  it('adds the round-12 MLX (Apple-Silicon) foundation entries', () => {
    // 3 mlx-community entries across the tiers, all engine:'mlx'.
    expect(MLX_MODELS.length).toBeGreaterThanOrEqual(3);
    const tiers = new Set(MLX_MODELS.map((m) => m.tier));
    expect(tiers).toEqual(new Set(['fast', 'balanced', 'intelligent']));
    for (const m of MLX_MODELS) {
      expect(modelEngine(m)).toBe('mlx');
      expect(m.hfRepo).toMatch(/^mlx-community\//);
      expect(m.publisher?.handle).toBe('mlx-community');
      expect(m.publisher?.reliable).toBe(true);
      // MLX text engine: no vision, no MTP/EAGLE variants, reserved (bytes 0).
      expect(m.input).toEqual(['text']);
      expect(m.variants).toBeUndefined();
      expect(m.verified).toBe(false);
      for (const f of m.files) expect(f.bytes).toBe(0);
    }
  });

  it('carries the canonical base repo for the Gemma-4 family (chat-template source)', () => {
    expect(getCatalogModel('gemma-4-e2b-it')?.baseRepo).toBe('google/gemma-4-E2B-it');
    expect(getCatalogModel('gemma-4-e4b-it')?.baseRepo).toBe('google/gemma-4-E4B-it');
    expect(getCatalogModel('gemma-4-12b-it')?.baseRepo).toBe('google/gemma-4-12b-it');
    expect(getCatalogModel('gemma-4-26b-a4b-it')?.baseRepo).toBe('google/gemma-4-26B-A4B-it');
    expect(getCatalogModel('gemma-4-31b-it')?.baseRepo).toBe('google/gemma-4-31B-it');
    // Every Gemma-4 entry declares one; non-Gemma entries do not (mechanism is
    // general/opt-in, not Gemma-hardcoded).
    for (const m of CATALOG) {
      if (m.id.startsWith('gemma-4-')) expect(m.baseRepo).toMatch(/^google\/gemma-4-/);
    }
    expect(getCatalogModel('qwen3.6-27b-mtp')?.baseRepo).toBeUndefined();
    expect(getCatalogModel('nemotron-3-nano-30b-a3b')?.baseRepo).toBeUndefined();
  });

  it('builds HF resolve URLs', () => {
    expect(hfResolveUrl('unsloth/gemma-4-E2B-it-GGUF', 'gemma-4-E2B-it-Q4_K_M.gguf')).toBe(
      'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf',
    );
  });
});
