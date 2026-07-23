import { describe, expect, it } from 'vitest';
import { flavorForSource, mapExperience, preselectSource, resolveMode } from './onboarding-logic';

describe('flavorForSource', () => {
  it('maps codex→codex, claude→claude, and neither→bobble (the native identity)', () => {
    expect(flavorForSource('codex')).toBe('codex');
    expect(flavorForSource('claude')).toBe('claude');
    expect(flavorForSource('neither')).toBe('bobble');
  });
});

describe('resolveMode', () => {
  it('honors an explicit light/dark theme mode', () => {
    expect(resolveMode('light', true)).toBe('light');
    expect(resolveMode('dark', false)).toBe('dark');
  });

  it('falls back to the OS preference for system/null', () => {
    expect(resolveMode('system', true)).toBe('dark');
    expect(resolveMode('system', false)).toBe('light');
    expect(resolveMode(null, true)).toBe('dark');
  });
});

describe('mapExperience', () => {
  it('sets tutorial + permission mode per level', () => {
    expect(mapExperience('new')).toEqual({ tutorial: true, permissionMode: 'review-all' });
    expect(mapExperience('knows-llamacpp')).toEqual({
      tutorial: false,
      permissionMode: 'reviewer',
    });
    expect(mapExperience('no-tutorial')).toEqual({ tutorial: false, permissionMode: 'bypass' });
  });
});

describe('preselectSource', () => {
  it('prefers Claude, then Codex, else neither', () => {
    expect(preselectSource({ claude: true, codex: true })).toBe('claude');
    expect(preselectSource({ claude: false, codex: true })).toBe('codex');
    expect(preselectSource({ claude: false, codex: false })).toBe('neither');
  });
});
