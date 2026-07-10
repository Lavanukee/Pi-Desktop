import { describe, expect, it } from 'vitest';
import type { LlmCatalogEntry } from '../../electron/ipc-contract';
import {
  baseModelName,
  categorizeByFamily,
  defaultVariant,
  displaySizeBytes,
  formatBytes,
  formatSpeed,
  groupCatalog,
  isReliablePublisher,
  mergeQuantLadder,
  modelFamily,
  percent,
  ramVerdict,
  selectedQuant,
  variantEntry,
} from './model-manager-logic';

describe('ramVerdict', () => {
  it('unknown RAM (0) is neutral and states the requirement', () => {
    const v = ramVerdict(16, 0);
    expect(v.tone).toBe('default');
    expect(v.fits).toBe(true);
    expect(v.label).toContain('16 GB');
  });

  it('insufficient RAM is danger + does not fit', () => {
    expect(ramVerdict(32, 16)).toEqual({ tone: 'danger', label: 'Needs more RAM', fits: false });
  });

  it('a tight-but-adequate fit is a warning', () => {
    // 18 total, needs 16 → 2 GB headroom (< 4) → tight.
    expect(ramVerdict(16, 18)).toEqual({ tone: 'warning', label: 'Tight fit', fits: true });
  });

  it('comfortable headroom is success', () => {
    expect(ramVerdict(16, 32)).toEqual({ tone: 'success', label: 'Fits comfortably', fits: true });
  });

  it('exact minimum counts as a (tight) fit, not insufficient', () => {
    expect(ramVerdict(16, 16).fits).toBe(true);
    expect(ramVerdict(16, 16).tone).toBe('warning');
  });
});

describe('formatBytes', () => {
  it('formats GB with one decimal under 10, none at/above', () => {
    expect(formatBytes(2.53e9)).toBe('2.5 GB');
    expect(formatBytes(24e9)).toBe('24 GB');
  });
  it('falls back to MB under a GB', () => {
    expect(formatBytes(700e6)).toBe('700 MB');
  });
  it('renders a dash for unknown/zero sizes', () => {
    expect(formatBytes(0)).toBe('—');
  });
});

describe('formatSpeed', () => {
  it('MB/s above a megabyte, KB/s below, empty for null/zero', () => {
    expect(formatSpeed(12.4e6)).toBe('12.4 MB/s');
    expect(formatSpeed(500e3)).toBe('500 KB/s');
    expect(formatSpeed(null)).toBe('');
    expect(formatSpeed(0)).toBe('');
  });
});

describe('percent', () => {
  it('rounds + clamps a 0..1 fraction, passes null through', () => {
    expect(percent(0.256)).toBe(26);
    expect(percent(1.4)).toBe(100);
    expect(percent(-0.2)).toBe(0);
    expect(percent(null)).toBeNull();
  });
});

describe('selectedQuant / displaySizeBytes', () => {
  const entry = {
    quants: [
      { quant: 'Q4_K_M', bytes: 2e9 },
      { quant: 'Q6_K', bytes: 3e9 },
    ],
  };
  it('picks the named quant, else the first', () => {
    expect(selectedQuant(entry, 'Q6_K')?.bytes).toBe(3e9);
    expect(selectedQuant(entry)?.quant).toBe('Q4_K_M');
    expect(selectedQuant(entry, 'nope')?.quant).toBe('Q4_K_M');
  });
  it('displaySizeBytes uses the selected quant size', () => {
    const full = { ...entry, id: 'x', displayName: 'X' } as never;
    expect(displaySizeBytes(full, 'Q6_K')).toBe(3e9);
  });
});

// ── round-12: reliable publishers ───────────────────────────────────────────
describe('isReliablePublisher', () => {
  it('accepts allowlisted handles (exact) and rejects community re-quanters', () => {
    expect(isReliablePublisher('unsloth')).toBe(true);
    expect(isReliablePublisher('Qwen')).toBe(true);
    expect(isReliablePublisher('ggml-org')).toBe(true);
    expect(isReliablePublisher('nvidia')).toBe(true);
    // Community re-quanter — NOT reliable (mirrors keystone's catalog).
    expect(isReliablePublisher('mradermacher')).toBe(false);
    expect(isReliablePublisher('some-random-org')).toBe(false);
  });
});

// ── round-12: de-duplicated model grouping ──────────────────────────────────
/** Narrow away the `| undefined` that noUncheckedIndexedAccess adds to array
 * lookups, throwing (failing the test) when the value is genuinely missing. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a defined value');
  return value;
}

function entry(over: Partial<LlmCatalogEntry> & Pick<LlmCatalogEntry, 'id' | 'displayName'>) {
  return {
    quants: [{ quant: 'Q4_K_M', bytes: 4e9 }],
    minRamGB: 8,
    contextWindow: 32_768,
    input: ['text'],
    license: 'Apache-2.0',
    mtp: false,
    vision: false,
    downloaded: false,
    recommended: false,
    ...over,
  } as LlmCatalogEntry;
}

const GEMMA_12B = entry({
  id: 'gemma-4-12b-it',
  displayName: 'Gemma 4 12B Instruct',
  minRamGB: 16,
  spec: 'mtp',
  mtp: true,
  variants: [{ method: 'mtp' }, { method: 'dflash', draftRepo: 'x/gemma-12b-dflash' }],
  publisher: { handle: 'unsloth', reliable: true },
  tier: 'balanced',
});
const GEMMA_E2B = entry({
  id: 'gemma-4-e2b-it',
  displayName: 'Gemma 4 E2B Instruct',
  minRamGB: 6,
  spec: 'mtp',
  mtp: true,
  variants: [{ method: 'mtp' }],
  publisher: { handle: 'unsloth', reliable: true },
});
const QWEN_27B_MTP = entry({
  id: 'qwen3.6-27b-mtp',
  displayName: 'Qwen3.6 27B (MTP)',
  minRamGB: 24,
  spec: 'mtp',
  mtp: true,
  hfRepo: 'unsloth/Qwen3.6-27B-MTP-GGUF',
  variants: [
    { method: 'mtp', embedded: true },
    { method: 'eagle3', draftRepo: 'gelim/Qwen3.6-27B-EAGLE3-GGUF' },
    { method: 'dflash', draftRepo: 'x/qwen-27b-dflash' },
  ],
});
const QWEN_27B_EAGLE3 = entry({
  id: 'qwen3.6-27b-eagle3',
  displayName: 'Qwen3.6 27B (EAGLE-3)',
  minRamGB: 24,
  spec: 'eagle3',
  hfRepo: 'unsloth/Qwen3.6-27B-GGUF',
  variants: [
    { method: 'eagle3', draftRepo: 'gelim/Qwen3.6-27B-EAGLE3-GGUF' },
    { method: 'dflash', draftRepo: 'x/qwen-27b-dflash' },
  ],
});

describe('baseModelName / modelFamily', () => {
  it('strips the speed-variant suffix so variants of one model collapse', () => {
    expect(baseModelName('Qwen3.6 27B (MTP)')).toBe('Qwen3.6 27B');
    expect(baseModelName('Qwen3.6 27B (EAGLE-3)')).toBe('Qwen3.6 27B');
    expect(baseModelName('Gemma 4 12B Instruct')).toBe('Gemma 4 12B Instruct');
  });
  it('derives the family (everything before the size token)', () => {
    expect(modelFamily('Gemma 4 12B Instruct')).toBe('Gemma 4');
    expect(modelFamily('Gemma 4 E2B Instruct')).toBe('Gemma 4');
    expect(modelFamily('Qwen3.6 27B (MTP)')).toBe('Qwen3.6');
    expect(modelFamily('NVIDIA Nemotron-3 Nano 30B-A3B')).toBe('NVIDIA Nemotron-3 Nano');
    expect(modelFamily('Gemma 4 26B-A4B Instruct')).toBe('Gemma 4');
  });
});

describe('groupCatalog (de-duplication)', () => {
  it('collapses the two Qwen3.6 27B entries into ONE group', () => {
    const groups = groupCatalog([GEMMA_E2B, GEMMA_12B, QWEN_27B_MTP, QWEN_27B_EAGLE3]);
    expect(groups).toHaveLength(3); // e2b, 12b, and ONE qwen 27b
    const qwen = groups.find((g) => g.displayName === 'Qwen3.6 27B');
    expect(qwen).toBeDefined();
    expect(qwen?.entries).toHaveLength(2);
  });

  it('picks the MTP/embedded entry as the primary', () => {
    const qwen = must(groupCatalog([QWEN_27B_EAGLE3, QWEN_27B_MTP])[0]);
    expect(qwen.primary.id).toBe('qwen3.6-27b-mtp');
    expect(defaultVariant(qwen)).toBe('mtp');
  });

  it('offers the deduped variant union in [MTP, DFlash, EAGLE-3] order', () => {
    const qwen = must(groupCatalog([QWEN_27B_MTP, QWEN_27B_EAGLE3])[0]);
    expect(qwen.variants.map((v) => v.method)).toEqual(['mtp', 'dflash', 'eagle3']);
  });

  it('resolves each variant → the concrete entry (repo) that provides it', () => {
    const qwen = must(groupCatalog([QWEN_27B_MTP, QWEN_27B_EAGLE3])[0]);
    // MTP → the embedded MTP repo; EAGLE-3 → its dedicated repo (spec === eagle3).
    expect(variantEntry(qwen, 'mtp').id).toBe('qwen3.6-27b-mtp');
    expect(variantEntry(qwen, 'eagle3').id).toBe('qwen3.6-27b-eagle3');
    // DFlash has no dedicated entry → resolves to the entry declaring it (primary).
    expect(variantEntry(qwen, 'dflash').id).toBe('qwen3.6-27b-mtp');
    // The DFlash option carries its draft repo for the Advanced view.
    expect(qwen.variants.find((v) => v.method === 'dflash')?.draftRepo).toBe('x/qwen-27b-dflash');
  });

  it('a single-variant model resolves to itself (no dropdown needed)', () => {
    const g = must(groupCatalog([GEMMA_E2B])[0]);
    expect(g.variants).toHaveLength(1);
    expect(variantEntry(g, defaultVariant(g)).id).toBe('gemma-4-e2b-it');
  });
});

describe('categorizeByFamily', () => {
  it('groups by family and sorts models within a family by size (RAM)', () => {
    const groups = groupCatalog([GEMMA_12B, GEMMA_E2B, QWEN_27B_MTP, QWEN_27B_EAGLE3]);
    const sections = categorizeByFamily(groups);
    const gemma = sections.find((s) => s.family === 'Gemma 4');
    expect(gemma?.groups.map((g) => g.displayName)).toEqual([
      'Gemma 4 E2B Instruct', // 6 GB before 16 GB
      'Gemma 4 12B Instruct',
    ]);
    // Families ordered by their smallest member (Gemma 6 GB before Qwen 24 GB).
    expect(sections.map((s) => s.family)).toEqual(['Gemma 4', 'Qwen3.6']);
  });
});

describe('mergeQuantLadder', () => {
  const base = [
    { quant: 'Q4_K_M', bytes: 4e9 },
    { quant: 'Q6_K', bytes: 6e9 },
  ];
  it('returns the base list (sorted Q-low→high) when no ladder is fetched', () => {
    expect(mergeQuantLadder(base).map((q) => q.quant)).toEqual(['Q4_K_M', 'Q6_K']);
  });
  it('merges a live hf:list-files ladder, filling sizes + adding new quants', () => {
    const merged = mergeQuantLadder(base, [
      { quant: 'Q2_K', sizeBytes: 2e9 },
      { quant: 'Q8_0', sizeBytes: 8e9 },
      { quant: 'Q4_K_M', sizeBytes: 4.1e9 }, // live size wins
    ]);
    expect(merged.map((q) => q.quant)).toEqual(['Q2_K', 'Q4_K_M', 'Q6_K', 'Q8_0']);
    expect(merged.find((q) => q.quant === 'Q4_K_M')?.bytes).toBe(4.1e9);
  });
  it('ignores fetched files without a quant label', () => {
    const merged = mergeQuantLadder(base, [{ sizeBytes: 1e9 }]);
    expect(merged).toHaveLength(2);
  });
});
