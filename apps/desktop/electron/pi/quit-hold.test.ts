import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPiQuitHold, type QuitHoldBridge } from './quit-hold';

const GRACE_MS = 1500;

class FakeBridge implements QuitHoldBridge {
  alive = true;
  sigkills = 0;
  private exitResolve: (() => void) | null = null;
  private readonly exitPromise = new Promise<void>((resolve) => {
    this.exitResolve = resolve;
  });

  whenExited(): Promise<void> {
    return this.exitPromise;
  }
  killNow(): void {
    this.sigkills += 1;
  }
  exit(): void {
    this.alive = false;
    this.exitResolve?.();
    this.exitResolve = null;
  }
}

class FakeApp {
  exits = 0;
  private listener: ((event: { preventDefault(): void }) => void) | null = null;

  on(_event: 'before-quit', listener: (event: { preventDefault(): void }) => void): void {
    this.listener = listener;
  }
  exit(): void {
    this.exits += 1;
  }
  emitBeforeQuit(): { prevented: boolean } {
    const result = { prevented: false };
    this.listener?.({
      preventDefault: () => {
        result.prevented = true;
      },
    });
    return result;
  }
}

interface Setup {
  app: FakeApp;
  bridges: FakeBridge[];
  disposeAll: ReturnType<typeof vi.fn>;
}

function setup(bridges: FakeBridge[]): Setup {
  const app = new FakeApp();
  const disposeAll = vi.fn();
  installPiQuitHold(app, {
    bridges: () => [...bridges],
    disposeAll,
    graceMs: GRACE_MS,
  });
  return { app, bridges, disposeAll };
}

describe('installPiQuitHold', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets the quit proceed (dispose only) when no bridge is alive', () => {
    const dead = new FakeBridge();
    dead.exit();
    const { app, disposeAll } = setup([dead]);
    expect(app.emitBeforeQuit().prevented).toBe(false);
    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(app.exits).toBe(0);
  });

  it('holds the quit, then exits once every bridge exits within the grace', async () => {
    const bridge = new FakeBridge();
    const { app, disposeAll } = setup([bridge]);
    expect(app.emitBeforeQuit().prevented).toBe(true);
    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(app.exits).toBe(0);

    bridge.exit();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.exits).toBe(1);
    expect(bridge.sigkills).toBe(0);
  });

  it('SIGKILLs survivors once the cap elapses, then exits', async () => {
    const wedged = new FakeBridge(); // ignores SIGTERM forever
    const clean = new FakeBridge();
    const { app } = setup([wedged, clean]);
    app.emitBeforeQuit();
    clean.exit();

    await vi.advanceTimersByTimeAsync(GRACE_MS + 249);
    expect(app.exits).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(wedged.sigkills).toBe(1);
    expect(clean.sigkills).toBe(0);
    expect(app.exits).toBe(1);
  });

  it('does not re-hold a second before-quit while already quitting', async () => {
    const bridge = new FakeBridge();
    const { app, disposeAll } = setup([bridge]);
    expect(app.emitBeforeQuit().prevented).toBe(true);
    expect(app.emitBeforeQuit().prevented).toBe(false);
    expect(disposeAll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(GRACE_MS + 250);
    expect(app.exits).toBe(1);
  });
});
