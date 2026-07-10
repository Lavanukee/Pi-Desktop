/**
 * Renderer half of the browser-agent bridge. Tabs are CanvasController-owned, so
 * when the model starts browsing the main-process bridge
 * (electron/canvas/browser-agent.ts) asks us — over `browser:agent-open-tab` —
 * to open/focus a dedicated agent browser tab; we open it (via the same
 * `upsertTab`/native-surface path a user browser tab uses, so the
 * WebContentsView mounts), mark it "driving", and report its id back over
 * `browser:agent-register`. The bridge then drives that tab and toggles the
 * "Pi is browsing" chrome via `browser:agent-driving`.
 *
 * A stable per-session key means repeat browsing reuses the one agent tab
 * instead of piling up duplicates; closing it releases the registration.
 */
import type { CanvasController } from '@pi-desktop/canvas';
import { useEffect, useRef } from 'react';
import { useCanvasStore } from '../../state/canvas-store';

/** Stable upsert key for the model's browser tab. */
const AGENT_TAB_KEY = 'pi:agent-browser';

export function useBrowserAgent(controller: CanvasController): void {
  const agentTabId = useRef<string | null>(null);

  useEffect(() => {
    const openTab = (): void => {
      const id = controller.upsertTab(AGENT_TAB_KEY, {
        kind: 'browser',
        title: 'Pi Browser',
        driving: true,
      });
      agentTabId.current = id;
      // Ensure the rail is visible so the WebContentsView actually mounts.
      useCanvasStore.getState().setCanvasOpen(true);
      void window.piDesktop.invoke('browser:agent-register', { tabId: id });
    };

    const applyDriving = (payload: { driving: boolean }): void => {
      const id = agentTabId.current;
      if (id !== null) controller.updateTab(id, { driving: payload.driving });
    };

    const unsubOpen = window.piDesktop.onEvent('browser:agent-open-tab', openTab);
    const unsubDriving = window.piDesktop.onEvent('browser:agent-driving', applyDriving);
    // Release the registration if the user closes the agent tab.
    const unsubController = controller.subscribe(() => {
      const id = agentTabId.current;
      if (id !== null && !controller.getState().tabs.some((t) => t.id === id)) {
        agentTabId.current = null;
        void window.piDesktop.invoke('browser:agent-release', { tabId: id });
      }
    });

    return () => {
      unsubOpen();
      unsubDriving();
      unsubController();
    };
  }, [controller]);
}
