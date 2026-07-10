import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  HARNESS_CONFIG_ENTRY,
  restoreConfig,
  type StoredEntryLike,
  updateConfig,
} from './state.js';

describe('restoreConfig', () => {
  it('returns defaults with no entries', () => {
    expect(restoreConfig([])).toEqual(DEFAULT_CONFIG);
  });

  it('restores the last written config (last write wins)', () => {
    const entries: StoredEntryLike[] = [
      {
        type: 'custom',
        customType: HARNESS_CONFIG_ENTRY,
        data: { mode: 'bypass', effort: 'low', preset: 'coding' },
      },
      {
        type: 'custom',
        customType: HARNESS_CONFIG_ENTRY,
        data: { mode: 'review-all', effort: 'max', preset: 'auto' },
      },
    ];
    expect(restoreConfig(entries)).toEqual({ mode: 'review-all', effort: 'max', preset: 'auto' });
  });

  it('ignores unrelated and malformed entries', () => {
    const entries: StoredEntryLike[] = [
      { type: 'custom', customType: 'other/thing', data: { mode: 'bypass' } },
      { type: 'assistant' },
      {
        type: 'custom',
        customType: HARNESS_CONFIG_ENTRY,
        data: { mode: 'nonsense', effort: 'medium' },
      },
    ];
    // mode "nonsense" is invalid → keeps default mode; effort "medium" applied.
    expect(restoreConfig(entries)).toEqual({
      mode: DEFAULT_CONFIG.mode,
      effort: 'medium',
      preset: 'auto',
    });
  });
});

describe('updateConfig', () => {
  it('applies valid patches and rejects invalid ones', () => {
    const next = updateConfig(DEFAULT_CONFIG, { mode: 'bypass', effort: 'high' });
    expect(next).toEqual({ mode: 'bypass', effort: 'high', preset: 'auto' });

    const bad = updateConfig(DEFAULT_CONFIG, {
      // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid input.
      mode: 'wat' as any,
      // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid input.
      effort: 'ultra' as any,
    });
    expect(bad).toEqual(DEFAULT_CONFIG);
  });

  it('updates the preset selection', () => {
    expect(updateConfig(DEFAULT_CONFIG, { preset: 'browser-use' }).preset).toBe('browser-use');
  });
});
