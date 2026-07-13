/**
 * Session isolation (backlog #2): starting or switching to a conversation must
 * give it its OWN clean canvas. `resetCanvasForNewSession` (the reset the
 * new-session / switch-session path calls) drops every tab the previous chat
 * accumulated (via the registered CanvasController) and slides the rail closed —
 * so canvases no longer pile up across "separate" chats.
 */
import { CanvasController } from '@pi-desktop/canvas';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerCanvasControllerReset,
  resetCanvasForNewSession,
  useCanvasStore,
} from './canvas-store';

afterEach(() => {
  registerCanvasControllerReset(null);
  useCanvasStore.getState().setCanvasOpen(false);
});

describe('resetCanvasForNewSession (new-session / switch-session clears the canvas)', () => {
  it('drops every canvas tab and closes the rail', () => {
    const controller = new CanvasController();
    controller.openTab({ kind: 'file', title: 'file1.txt' });
    controller.openTab({ kind: 'terminal', title: 'Terminal' });
    controller.openTab({ kind: 'browser', title: 'New tab' });
    expect(controller.getState().tabs).toHaveLength(3);

    // The rail is open (a prior chat had tabs showing).
    useCanvasStore.getState().setCanvasOpen(true);
    // The app shell registers the live controller's reset.
    registerCanvasControllerReset(() => controller.reset());

    resetCanvasForNewSession();

    // Canvas is emptied and the rail slid closed → the new chat starts clean.
    expect(controller.getState().tabs).toHaveLength(0);
    expect(controller.getState().activeTabId).toBeNull();
    expect(useCanvasStore.getState().canvasOpen).toBe(false);
  });

  it('is a safe no-op before the shell registers a controller', () => {
    // No controller registered (e.g. called before mount) → just closes the rail.
    useCanvasStore.getState().setCanvasOpen(true);
    expect(() => resetCanvasForNewSession()).not.toThrow();
    expect(useCanvasStore.getState().canvasOpen).toBe(false);
  });

  it('unregistering stops the bridge from touching a stale controller', () => {
    const controller = new CanvasController();
    controller.openTab({ kind: 'file', title: 'keep.txt' });
    registerCanvasControllerReset(() => controller.reset());
    registerCanvasControllerReset(null);

    resetCanvasForNewSession();

    // The unregistered controller's tabs are untouched.
    expect(controller.getState().tabs).toHaveLength(1);
  });
});
