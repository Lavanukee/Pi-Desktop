/**
 * Per-session canvas isolation. Starting/switching a conversation must give it
 * its OWN canvas: `resetCanvasForNewSession` clears a first-visit chat, while
 * `snapshotCanvas`/`restoreCanvas` save the current chat's tabs on switch-away
 * and restore them on switch-back — so canvases no longer leak across "separate"
 * chats, and a chat's tabs come back when you return to it.
 */
import { CanvasController } from '@pi-desktop/canvas';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerCanvasController,
  resetCanvasForNewSession,
  restoreCanvas,
  snapshotCanvas,
  useCanvasStore,
} from './canvas-store';

afterEach(() => {
  registerCanvasController(null);
  useCanvasStore.getState().setCanvasOpen(false);
});

describe('resetCanvasForNewSession (first-visit chat starts clean)', () => {
  it('drops every canvas tab and closes the rail', () => {
    const controller = new CanvasController();
    controller.openTab({ kind: 'file', title: 'file1.txt' });
    controller.openTab({ kind: 'terminal', title: 'Terminal' });
    controller.openTab({ kind: 'browser', title: 'New tab' });
    expect(controller.getState().tabs).toHaveLength(3);

    useCanvasStore.getState().setCanvasOpen(true);
    registerCanvasController(controller);

    resetCanvasForNewSession();

    expect(controller.getState().tabs).toHaveLength(0);
    expect(controller.getState().activeTabId).toBeNull();
    expect(useCanvasStore.getState().canvasOpen).toBe(false);
  });

  it('is a safe no-op before the shell registers a controller', () => {
    useCanvasStore.getState().setCanvasOpen(true);
    expect(() => resetCanvasForNewSession()).not.toThrow();
    expect(useCanvasStore.getState().canvasOpen).toBe(false);
    expect(snapshotCanvas()).toBeNull();
  });

  it('unregistering stops the bridge from touching a stale controller', () => {
    const controller = new CanvasController();
    controller.openTab({ kind: 'file', title: 'keep.txt' });
    registerCanvasController(controller);
    registerCanvasController(null);

    resetCanvasForNewSession();

    expect(controller.getState().tabs).toHaveLength(1);
  });
});

describe('snapshotCanvas / restoreCanvas (per-chat preserve on switch)', () => {
  it('round-trips a chat’s tabs and opens the rail only when it had tabs', () => {
    const controller = new CanvasController();
    registerCanvasController(controller);

    // Chat A has two tabs.
    controller.openTab({ kind: 'file', title: 'a.txt' });
    controller.openTab({ kind: 'image', title: 'pic.png' });
    const snapA = snapshotCanvas();
    expect(snapA?.tabs).toHaveLength(2);

    // Switch to a fresh chat B → clean canvas.
    resetCanvasForNewSession();
    expect(controller.getState().tabs).toHaveLength(0);
    expect(useCanvasStore.getState().canvasOpen).toBe(false);

    // Switch back to A → its tabs return and the rail opens.
    if (snapA !== null) restoreCanvas(snapA);
    expect(controller.getState().tabs).toHaveLength(2);
    expect(controller.getState().tabs.map((t) => t.title)).toEqual(['a.txt', 'pic.png']);
    expect(useCanvasStore.getState().canvasOpen).toBe(true);
  });

  it('restoring an empty snapshot leaves the rail closed', () => {
    const controller = new CanvasController();
    registerCanvasController(controller);
    const empty = snapshotCanvas();
    controller.openTab({ kind: 'file', title: 'x.txt' });
    if (empty !== null) restoreCanvas(empty);
    expect(controller.getState().tabs).toHaveLength(0);
    expect(useCanvasStore.getState().canvasOpen).toBe(false);
  });
});
