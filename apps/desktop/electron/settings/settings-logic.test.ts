import { describe, expect, it } from 'vitest';
import type { OnboardingChoices } from '../import/import-contract';
import {
  clampSettings,
  DEFAULT_SETTINGS,
  mergeSettingsPatch,
  seedFromOnboarding,
} from './settings-logic';

describe('clampSettings', () => {
  it('returns defaults for junk input', () => {
    expect(clampSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(clampSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(clampSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values and falls back per-field on invalid ones', () => {
    const s = clampSettings({
      theme: { flavor: 'codex', mode: 'purple' },
      permissionMode: 'bypass',
      effort: 'max',
      search: { brave: 'abc', tavily: 123 },
      mcpMode: 'native',
      capabilities: { image: true, video: 'yes' },
    });
    expect(s.theme.flavor).toBe('codex');
    expect(s.theme.mode).toBe(DEFAULT_SETTINGS.theme.mode); // 'purple' rejected
    expect(s.permissionMode).toBe('bypass');
    expect(s.effort).toBe('max');
    expect(s.search).toEqual({ brave: 'abc', tavily: '' }); // non-string rejected
    expect(s.mcpMode).toBe('native');
    expect(s.capabilities).toEqual({ image: true, video: false, audio: false, threeD: false });
  });

  it('always stamps version 1', () => {
    expect(clampSettings({ version: 99 }).version).toBe(1);
  });
});

describe('mergeSettingsPatch', () => {
  it('merges nested objects one level deep and re-clamps', () => {
    const next = mergeSettingsPatch(DEFAULT_SETTINGS, {
      theme: { flavor: 'codex' },
      search: { brave: 'k' },
      effort: 'high',
    });
    expect(next.theme.flavor).toBe('codex');
    expect(next.theme.mode).toBe(DEFAULT_SETTINGS.theme.mode); // untouched key preserved
    expect(next.search).toEqual({ brave: 'k', tavily: '' });
    expect(next.effort).toBe('high');
  });

  it('rejects an invalid patch value, keeping the current one', () => {
    const next = mergeSettingsPatch(DEFAULT_SETTINGS, {
      permissionMode: 'yolo' as never,
    });
    expect(next.permissionMode).toBe(DEFAULT_SETTINGS.permissionMode);
  });
});

describe('seedFromOnboarding', () => {
  const choices: OnboardingChoices = {
    source: 'claude',
    imports: { mcp: false, theme: true, sessions: false, skills: false },
    theme: { flavor: 'codex', mode: 'light' },
    experience: 'new',
    tutorial: true,
    permissionMode: 'review-all',
    capabilities: { image: true, video: false, audio: false, threeD: true },
    importedSessionCount: 0,
  };

  it('carries theme, permission mode and capabilities forward', () => {
    const s = seedFromOnboarding(choices, null);
    expect(s.theme).toEqual({ flavor: 'codex', mode: 'light' });
    expect(s.permissionMode).toBe('review-all');
    expect(s.capabilities).toEqual({ image: true, video: false, audio: false, threeD: true });
    expect(s.mcpMode).toBe('lite'); // no registry → default
  });

  it('respects an existing mcp registry mode', () => {
    expect(seedFromOnboarding(choices, 'native').mcpMode).toBe('native');
    expect(seedFromOnboarding(null, 'native').mcpMode).toBe('native');
  });

  it('returns pure defaults when there is no onboarding record', () => {
    expect(seedFromOnboarding(null, null)).toEqual(DEFAULT_SETTINGS);
  });
});
