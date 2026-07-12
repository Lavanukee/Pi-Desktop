/**
 * Round-12 footer dropdown (W3): the popup offers Auto + the three capability
 * tiers, and `buildTierRows` decides — per experience mode — which line leads.
 * USER mode leads with the friendly tier label (real model name grey underneath);
 * POWER mode leads with the real model name (tier label grey underneath).
 */
import { describe, expect, it } from 'vitest';
import type { LlmTierPick } from '../../electron/ipc-contract';
import type { ModelSelection } from '../../electron/settings/settings-contract';
import { buildTierRows, chipLabel } from './footer-models';

function pick(modelId: string, displayName: string, over: Partial<LlmTierPick> = {}): LlmTierPick {
  return {
    modelId,
    displayName,
    quant: 'Q4_K_M',
    launchMode: 'fast-text',
    vision: false,
    bytes: 16e9,
    downloaded: true,
    ...over,
  };
}

const tierModels = {
  fast: pick('gemma-4-e2b-it', 'gemma4 e2b', { bytes: 2e9 }),
  balanced: pick('gemma-4-12b-it', 'gemma4 12b', { bytes: 8e9 }),
  intelligent: pick('qwen3.6-27b-mtp', 'qwen3.6 27b', { bytes: 16e9, downloaded: false }),
};

describe('buildTierRows (round-12)', () => {
  it('USER mode: tier label leads, the real model name is the grey secondary', () => {
    const rows = buildTierRows(tierModels, 'user');
    expect(rows.map((r) => r.tier)).toEqual(['fast', 'balanced', 'intelligent']);
    expect(rows[0]).toMatchObject({ primary: 'Fast', secondary: 'gemma4 e2b' });
    expect(rows[1]).toMatchObject({ primary: 'Balanced', secondary: 'gemma4 12b' });
    expect(rows[2]).toMatchObject({ primary: 'Intelligent', secondary: 'qwen3.6 27b' });
  });

  it('POWER mode: the real model name leads, the tier label is the grey secondary', () => {
    const rows = buildTierRows(tierModels, 'power');
    expect(rows[0]).toMatchObject({ primary: 'gemma4 e2b', secondary: 'Fast' });
    expect(rows[1]).toMatchObject({ primary: 'gemma4 12b', secondary: 'Balanced' });
    expect(rows[2]).toMatchObject({ primary: 'qwen3.6 27b', secondary: 'Intelligent' });
  });

  it('carries the downloaded flag + size per tier (drives the download nudge)', () => {
    const rows = buildTierRows(tierModels, 'user');
    expect(rows[0]).toMatchObject({ downloaded: true, bytes: 2e9 });
    expect(rows[2]).toMatchObject({ downloaded: false, bytes: 16e9 });
  });

  it('degrades gracefully before the catalog loads (labels only, no grey name)', () => {
    const rows = buildTierRows(undefined, 'user');
    expect(rows.map((r) => r.primary)).toEqual(['Fast', 'Balanced', 'Intelligent']);
    expect(rows.every((r) => r.secondary === null && !r.downloaded)).toBe(true);

    // Power mode still falls back to the tier label as the primary line.
    const power = buildTierRows(undefined, 'power');
    expect(power.map((r) => r.primary)).toEqual(['Fast', 'Balanced', 'Intelligent']);
  });
});

/**
 * Round-A (#3): the model chip names the SELECTION MODE, identically in user and
 * power mode. `auto` → "Auto · <loaded model>" — the name of the model ACTUALLY
 * RESIDENT right now (never the routed tier), resting on plain "Auto" before any
 * model is resident; `tier` → a friendly tier label; `model` → the pinned model's
 * name — never the raw model id when a tier is chosen.
 */
describe('chipLabel (round-A #3)', () => {
  const auto: ModelSelection = { mode: 'auto' };

  it('Auto names the ACTUALLY-LOADED model (not the tier) — in BOTH modes', () => {
    expect(chipLabel('power', auto, 'gemma4 e2b')).toBe('Auto · gemma4 e2b');
    expect(chipLabel('power', auto, 'gemma4 12b')).toBe('Auto · gemma4 12b');
    expect(chipLabel('user', auto, 'qwen3.6 27b')).toBe('Auto · qwen3.6 27b');
    expect(chipLabel('user', auto, 'gemma4 e2b')).toBe('Auto · gemma4 e2b');
  });

  it('Auto before any model is resident: plain "Auto" (in both modes)', () => {
    expect(chipLabel('user', auto, null)).toBe('Auto');
    expect(chipLabel('power', auto, null)).toBe('Auto');
  });

  it('a pinned capability tier: the friendly TIER label, not the raw model id', () => {
    expect(chipLabel('user', { mode: 'tier', tier: 'fast' }, 'gemma-4-e2b-it')).toBe('Fast');
    expect(chipLabel('user', { mode: 'tier', tier: 'balanced' }, 'gemma-4-12b-it')).toBe(
      'Balanced',
    );
    expect(chipLabel('user', { mode: 'tier', tier: 'intelligent' }, 'qwen')).toBe('Intelligent');
  });

  it('a pinned specific model: its friendly (loaded) name, in both modes', () => {
    expect(chipLabel('power', { mode: 'model', modelId: 'm1' }, 'gemma4 12b')).toBe('gemma4 12b');
    expect(chipLabel('user', { mode: 'model', modelId: 'm1' }, 'Gemma 4 12B')).toBe('Gemma 4 12B');
  });

  it('returns null (→ caller supplies "Choose model") only when a pinned model has no name yet', () => {
    // Auto always names at least "Auto", so the null fallback is reachable only via
    // a pinned `model` selection whose name has not resolved — in either mode.
    expect(chipLabel('power', { mode: 'model', modelId: 'm1' }, null)).toBeNull();
    expect(chipLabel('user', { mode: 'model', modelId: 'm1' }, null)).toBeNull();
  });
});
