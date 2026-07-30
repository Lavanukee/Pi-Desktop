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
import { usePiStore } from '../../state/pi-slice';

/** Stable upsert key for the model's browser tab. */
const AGENT_TAB_KEY = 'pi:agent-browser';

/** Fixed id of the main-owned headless agent view (must match the main bridge). */
const HEADLESS_AGENT_TAB_ID = 'pi:agent-headless';

/**
 * The browser tab the agent should drive: the one the user is looking at if it is
 * a browser, else the newest browser tab, else none (open our own).
 *
 * Exported for the test — the preference order is the whole behaviour.
 */
export function pickAgentBrowserTab(
  tabs: readonly { id: string; kind: string }[],
  activeTabId: string | null,
): string | undefined {
  const active = tabs.find((t) => t.id === activeTabId);
  if (active?.kind === 'browser') return active.id;
  const browsers = tabs.filter((t) => t.kind === 'browser');
  return browsers[browsers.length - 1]?.id;
}

function adoptOrOpenBrowserTab(controller: CanvasController): string {
  const state = controller.getState();
  const existing = pickAgentBrowserTab(state.tabs, state.activeTabId);
  if (existing !== undefined) {
    controller.updateTab(existing, { driving: true });
    return existing;
  }
  return controller.upsertTab(AGENT_TAB_KEY, {
    kind: 'browser',
    title: 'Pi Browser',
    driving: true,
  });
}

export function useBrowserAgent(controller: CanvasController): void {
  const agentTabId = useRef<string | null>(null);

  // When a background browse ends, release the headless view so the NEXT browse
  // re-opens fresh — a visible canvas tab if the chat is now viewed (otherwise the
  // hidden view would be reused and the browsing would stay invisible).
  const bgStreaming = usePiStore((s) => s.bgRun?.streaming === true);
  const prevBgStreaming = useRef(false);
  useEffect(() => {
    if (prevBgStreaming.current && !bgStreaming) {
      void window.piDesktop.invoke('browser:agent-release', { tabId: HEADLESS_AGENT_TAB_ID });
    }
    prevBgStreaming.current = bgStreaming;
  }, [bgStreaming]);

  useEffect(() => {
    const openTab = (): void => {
      // A chat browsing in the BACKGROUND must not open its "Pi is browsing" tab
      // in the chat the user is currently VIEWING (the reported canvas leak). Tell
      // main to browse HEADLESSLY instead (a hidden main-owned view) — the model
      // keeps browsing via DOM snapshots; nothing surfaces in the viewed canvas.
      if (usePiStore.getState().bgRun?.streaming === true) {
        void window.piDesktop.invoke('browser:agent-headless', {});
        return;
      }
      /*
       * DRIVE THE TAB THE USER IS ALREADY LOOKING AT.
       *
       * This always created its own "Pi Browser" tab, keyed AGENT_TAB_KEY. With a
       * page already open in the canvas browser that meant a SECOND, blank tab —
       * and the agent registered against that one, so `browser_snapshot` read
       * about:blank and reported no interactive elements. jedd: "it knows what tab
       * I have open but the read call is reading the about blank???" It did know;
       * it was reading somewhere else.
       *
       * So: adopt the browser tab in front of the user — the active one if it is a
       * browser, else the most recently opened browser tab — and only open a tab
       * of our own when there is no browser open at all.
       */
      const id = adoptOrOpenBrowserTab(controller);
      agentTabId.current = id;
      // Ensure the rail is visible so the WebContentsView actually mounts.
      useCanvasStore.getState().setCanvasOpen(true);
      void window.piDesktop.invoke('browser:agent-register', { tabId: id });
    };

    const applyDriving = (payload: { driving: boolean }): void => {
      if (usePiStore.getState().bgRun?.streaming === true) return;
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
