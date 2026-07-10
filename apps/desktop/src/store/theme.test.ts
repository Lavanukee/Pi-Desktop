import { beforeEach, describe, expect, it } from 'vitest';
import { applyThemeAttributes, useThemeStore } from './theme';

beforeEach(() => {
  useThemeStore.setState({ flavor: 'claude', mode: 'dark' });
});

describe('theme store', () => {
  it('defaults to claude/dark, matching the attributes pre-set in index.html', () => {
    expect(useThemeStore.getState().flavor).toBe('claude');
    expect(useThemeStore.getState().mode).toBe('dark');
  });

  it('toggles flavor between claude and codex', () => {
    useThemeStore.getState().toggleFlavor();
    expect(useThemeStore.getState().flavor).toBe('codex');
    useThemeStore.getState().toggleFlavor();
    expect(useThemeStore.getState().flavor).toBe('claude');
  });

  it('toggles mode between dark and light', () => {
    useThemeStore.getState().toggleMode();
    expect(useThemeStore.getState().mode).toBe('light');
    useThemeStore.getState().toggleMode();
    expect(useThemeStore.getState().mode).toBe('dark');
  });

  it('supports all four flavor/mode combinations via setters', () => {
    const seen: string[] = [];
    for (const flavor of ['claude', 'codex'] as const) {
      for (const mode of ['dark', 'light'] as const) {
        useThemeStore.getState().setFlavor(flavor);
        useThemeStore.getState().setMode(mode);
        seen.push(`${useThemeStore.getState().flavor}/${useThemeStore.getState().mode}`);
      }
    }
    expect(seen).toEqual(['claude/dark', 'claude/light', 'codex/dark', 'codex/light']);
  });
});

describe('applyThemeAttributes', () => {
  it('writes both data attributes to the target element', () => {
    const written = new Map<string, string>();
    applyThemeAttributes(
      { setAttribute: (name, value) => written.set(name, value) },
      { flavor: 'codex', mode: 'light' },
    );
    expect(written.get('data-flavor')).toBe('codex');
    expect(written.get('data-mode')).toBe('light');
  });
});
