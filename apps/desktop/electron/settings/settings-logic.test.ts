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

  it('defaults userMode to user and rejects an invalid one', () => {
    expect(DEFAULT_SETTINGS.userMode).toBe('user');
    expect(clampSettings({}).userMode).toBe('user');
    expect(clampSettings({ userMode: 'wizard' }).userMode).toBe('user');
    expect(clampSettings({ userMode: 'power' }).userMode).toBe('power');
  });

  it('defaults enginePreference to llamacpp and rejects an invalid one', () => {
    expect(DEFAULT_SETTINGS.enginePreference).toBe('llamacpp');
    expect(clampSettings({}).enginePreference).toBe('llamacpp');
    expect(clampSettings({ enginePreference: 'cuda' }).enginePreference).toBe('llamacpp');
    expect(clampSettings({ enginePreference: 'mlx' }).enginePreference).toBe('mlx');
  });

  it('defaults sidebarScale/menuScale to 1.0 and clamps out-of-range values', () => {
    expect(DEFAULT_SETTINGS.sidebarScale).toBe(1.0);
    expect(DEFAULT_SETTINGS.menuScale).toBe(1.0);
    expect(clampSettings({}).sidebarScale).toBe(1.0);
    expect(clampSettings({}).menuScale).toBe(1.0);
    // Below the floor clamps up to 0.8; above the ceiling clamps down to 1.5.
    expect(clampSettings({ sidebarScale: 0.5 }).sidebarScale).toBe(0.8);
    expect(clampSettings({ sidebarScale: 3 }).sidebarScale).toBe(1.5);
    expect(clampSettings({ menuScale: 0.5 }).menuScale).toBe(0.8);
    expect(clampSettings({ menuScale: 3 }).menuScale).toBe(1.5);
    // A valid in-range value is kept; junk falls back to the default.
    expect(clampSettings({ sidebarScale: 1.25 }).sidebarScale).toBe(1.25);
    expect(clampSettings({ menuScale: 'big' }).menuScale).toBe(1.0);
    expect(clampSettings({ sidebarScale: Number.NaN }).sidebarScale).toBe(1.0);
  });

  it('defaults modelSelection to auto and effortMode to auto', () => {
    expect(DEFAULT_SETTINGS.modelSelection).toEqual({ mode: 'auto' });
    expect(DEFAULT_SETTINGS.effortMode).toBe('auto');
    expect(clampSettings({}).modelSelection).toEqual({ mode: 'auto' });
    expect(clampSettings({}).effortMode).toBe('auto');
  });

  it('clamps a valid modelSelection tier / model / auto and rejects junk', () => {
    expect(
      clampSettings({ modelSelection: { mode: 'tier', tier: 'intelligent' } }).modelSelection,
    ).toEqual({ mode: 'tier', tier: 'intelligent' });
    expect(
      clampSettings({ modelSelection: { mode: 'model', modelId: 'gemma-4-e2b-it' } })
        .modelSelection,
    ).toEqual({ mode: 'model', modelId: 'gemma-4-e2b-it' });
    expect(clampSettings({ modelSelection: { mode: 'auto' } }).modelSelection).toEqual({
      mode: 'auto',
    });
    // Invalid tier / empty model id / missing fields / junk → default auto.
    expect(
      clampSettings({ modelSelection: { mode: 'tier', tier: 'wizard' } }).modelSelection,
    ).toEqual({
      mode: 'auto',
    });
    expect(
      clampSettings({ modelSelection: { mode: 'model', modelId: '' } }).modelSelection,
    ).toEqual({
      mode: 'auto',
    });
    expect(clampSettings({ modelSelection: 'nope' }).modelSelection).toEqual({ mode: 'auto' });
    expect(clampSettings({ modelSelection: { mode: 'bogus' } }).modelSelection).toEqual({
      mode: 'auto',
    });
  });

  it('clamps effortMode to auto|level, rejecting invalid values', () => {
    expect(clampSettings({ effortMode: 'level' }).effortMode).toBe('level');
    expect(clampSettings({ effortMode: 'auto' }).effortMode).toBe('auto');
    expect(clampSettings({ effortMode: 'turbo' }).effortMode).toBe('auto');
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

  it('persists a userMode patch (round-trips power)', () => {
    const powered = mergeSettingsPatch(DEFAULT_SETTINGS, { userMode: 'power' });
    expect(powered.userMode).toBe('power');
    // and back to user
    expect(mergeSettingsPatch(powered, { userMode: 'user' }).userMode).toBe('user');
  });

  it('replaces the modelSelection union wholesale and re-clamps effortMode', () => {
    const pinned = mergeSettingsPatch(DEFAULT_SETTINGS, {
      modelSelection: { mode: 'tier', tier: 'fast' },
      effortMode: 'level',
    });
    expect(pinned.modelSelection).toEqual({ mode: 'tier', tier: 'fast' });
    expect(pinned.effortMode).toBe('level');
    // back to auto
    expect(mergeSettingsPatch(pinned, { modelSelection: { mode: 'auto' } }).modelSelection).toEqual(
      {
        mode: 'auto',
      },
    );
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
