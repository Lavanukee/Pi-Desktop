import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectUserMode, setUserMode, useSettingsStore } from './settings-store';

// Snapshot the store's built-in DEFAULTS so each test starts clean.
const initialSettings = useSettingsStore.getState().settings;

// The store's update() persists via window.piDesktop.invoke and then re-applies
// the theme (matchMedia) + icon stroke (document). Stub just enough of those
// globals so the node test env can exercise the real code path. The mock echoes
// the patch back merged onto the current doc, standing in for the main process.
const invoke = vi.fn(async (channel: string, arg: { patch?: Record<string, unknown> }) => {
  const current = useSettingsStore.getState().settings;
  if (channel === 'settings:set') return { ...current, ...(arg?.patch ?? {}) };
  return current;
});

beforeEach(() => {
  invoke.mockClear();
  useSettingsStore.setState({ settings: initialSettings, loaded: false }, false);
  vi.stubGlobal('window', {
    piDesktop: { invoke },
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('document', {
    documentElement: { style: { setProperty: () => {} } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('settings-store userMode', () => {
  it('defaults to "user"', () => {
    expect(useSettingsStore.getState().settings.userMode).toBe('user');
    expect(selectUserMode(useSettingsStore.getState())).toBe('user');
  });

  it('setUserMode persists via settings:set and updates the selector', async () => {
    await setUserMode('power');

    expect(invoke).toHaveBeenCalledWith('settings:set', { patch: { userMode: 'power' } });
    expect(selectUserMode(useSettingsStore.getState())).toBe('power');
    expect(useSettingsStore.getState().settings.userMode).toBe('power');
  });

  it('round-trips back to "user"', async () => {
    await setUserMode('power');
    await setUserMode('user');
    expect(selectUserMode(useSettingsStore.getState())).toBe('user');
  });
});
