/**
 * Renderer half of the GENERATION bridge — the twin of `useBrowserAgent`. When a
 * `generate_image` / `generate_video` tool runs, the main-process gen manager
 * (electron/gen/gen-manager.ts) streams the job's live surface data over
 * `gen:open` (initial) / `gen:update` (each candidate/step). This hook upserts a
 * `gen-image` canvas tab for the job and feeds each payload into the gen-canvas
 * surface via `genImageContent(...)`, so the candidate grid + progress bar stream
 * as the job runs; it also acks the mount back to main over `gen:register`.
 *
 * Gated on the EXPERIMENTAL generation flag (`experimentalGeneration` /
 * `?gen=1`): with the flag off nothing subscribes and no gen surface registers,
 * so the app is byte-for-byte its current self. The surface is registered
 * additively on the process-wide registry while the hook is mounted+enabled, and
 * unregistered on cleanup.
 */
import type { CanvasController } from '@pi-desktop/canvas';
import { genImageContent, registerGenSurfacesDefault } from '@pi-desktop/gen-canvas';
import { useEffect } from 'react';
import { useCanvasStore } from '../../state/canvas-store';
import { usePiStore } from '../../state/pi-slice';
import { useExperimentalGeneration } from '../../state/settings-store';

/** Launch-time dev override (`?gen=1`, surfaced by main from `PI_DESKTOP_GEN=1`). */
const GEN_PARAM =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('gen');

export function useGen(controller: CanvasController): void {
  // Reactive to the persisted flag; the launch-time override forces it on.
  const enabled = useExperimentalGeneration() || GEN_PARAM;

  useEffect(() => {
    if (!enabled) return;
    // Register the gen-image surface additively for as long as the hook is live.
    const unregisterSurface = registerGenSurfacesDefault();
    // job tabId (main) → controller tab id.
    const openTabs = new Map<string, string>();

    const upsert = (tabId: string, payload: Parameters<typeof genImageContent>[0]): string => {
      const id = controller.upsertTab(tabId, {
        kind: 'gen-image',
        title: 'Generation',
        streaming: payload.status === 'generating',
        artifact: { id: tabId, title: 'Generation', content: genImageContent(payload) },
      });
      openTabs.set(tabId, id);
      return id;
    };

    const unsubOpen = window.piDesktop.onEvent('gen:open', ({ tabId, payload }) => {
      // A chat generating media in the BACKGROUND must not pop its Generation tab
      // into the chat the user is currently viewing (session-agnostic IPC channel).
      if (usePiStore.getState().bgRun?.streaming === true) return;
      const id = upsert(tabId, payload);
      // Ensure the rail is open so the freshly-routed surface is visible.
      useCanvasStore.getState().setCanvasOpen(true);
      void window.piDesktop.invoke('gen:register', { tabId: id });
    });

    const unsubUpdate = window.piDesktop.onEvent('gen:update', ({ tabId, payload }) => {
      const id = openTabs.get(tabId) ?? upsert(tabId, payload);
      controller.updateTab(id, {
        streaming: payload.status === 'generating',
        artifact: { id: tabId, title: 'Generation', content: genImageContent(payload) },
      });
    });

    return () => {
      unsubOpen();
      unsubUpdate();
      unregisterSurface();
    };
  }, [controller, enabled]);
}
