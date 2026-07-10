import { describe, expect, it, vi } from 'vitest';
import { resolveRendererTarget, resolveSecondInstanceWindow } from './window-policy';

describe('resolveRendererTarget', () => {
  it('loads the dev server in unpackaged builds when the env var is set', () => {
    expect(
      resolveRendererTarget({
        isPackaged: false,
        devServerUrl: 'http://localhost:5173/',
        e2e: false,
      }),
    ).toEqual({ kind: 'dev-server', url: 'http://localhost:5173/' });
  });

  it('ignores VITE_DEV_SERVER_URL entirely in packaged builds', () => {
    expect(
      resolveRendererTarget({
        isPackaged: true,
        devServerUrl: 'http://evil.example/payload',
        e2e: false,
      }),
    ).toEqual({ kind: 'packaged-file', query: undefined });
  });

  it('falls back to the packaged file when the env var is unset or empty', () => {
    expect(
      resolveRendererTarget({ isPackaged: false, devServerUrl: undefined, e2e: false }),
    ).toEqual({ kind: 'packaged-file', query: undefined });
    expect(resolveRendererTarget({ isPackaged: false, devServerUrl: '', e2e: false })).toEqual({
      kind: 'packaged-file',
      query: undefined,
    });
  });

  it('threads the piE2E opt-in into the file query', () => {
    expect(
      resolveRendererTarget({ isPackaged: false, devServerUrl: undefined, e2e: true }),
    ).toEqual({ kind: 'packaged-file', query: { piE2E: '1' } });
  });

  it('threads the piE2E opt-in into the dev-server URL', () => {
    expect(
      resolveRendererTarget({
        isPackaged: false,
        devServerUrl: 'http://localhost:5173/',
        e2e: true,
      }),
    ).toEqual({ kind: 'dev-server', url: 'http://localhost:5173/?piE2E=1' });
  });
});

function makeWindow(minimized = false) {
  return {
    isMinimized: () => minimized,
    restore: vi.fn(),
    focus: vi.fn(),
  };
}

describe('resolveSecondInstanceWindow', () => {
  it('restores and focuses a minimized existing window', () => {
    const window = makeWindow(true);
    const createWindow = vi.fn();

    const result = resolveSecondInstanceWindow({ isReady: true, window, createWindow });

    expect(result).toBe(window);
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(createWindow).not.toHaveBeenCalled();
  });

  it('focuses without restoring when the window is not minimized', () => {
    const window = makeWindow();

    resolveSecondInstanceWindow({ isReady: true, window, createWindow: vi.fn() });

    expect(window.restore).not.toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it('creates a window when none exists (macOS relaunch with all windows closed)', () => {
    const created = makeWindow();
    const createWindow = vi.fn(() => created);

    const result = resolveSecondInstanceWindow({ isReady: true, window: null, createWindow });

    expect(result).toBe(created);
    expect(createWindow).toHaveBeenCalledOnce();
  });

  it('does nothing before app ready — whenReady creates the first window itself', () => {
    const createWindow = vi.fn();

    const result = resolveSecondInstanceWindow({ isReady: false, window: null, createWindow });

    expect(result).toBeNull();
    expect(createWindow).not.toHaveBeenCalled();
  });
});
