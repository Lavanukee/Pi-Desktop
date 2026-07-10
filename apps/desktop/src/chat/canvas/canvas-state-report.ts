/**
 * Canvas-awareness (renderer half): push a COMPACT snapshot of what's on the
 * canvas to main whenever the surfaces / active tab change, so the model's
 * `context` hook can inject a `<canvas_state>` block and always know what the
 * user is looking at.
 *
 * The renderer owns the tab model (@pi-desktop/canvas's CanvasController); main
 * owns the live browser view. So we report the compact per-surface shape here
 * (including each browser tab's id) and main re-enriches browser url/title from
 * the authoritative live view at read time (electron/canvas/browser-agent.ts).
 *
 * `toCanvasState` is a pure map (unit-tested); `useCanvasStateReporter`
 * subscribes to the controller, debounces, and skips redundant sends.
 */

import type { CanvasState, CanvasSurfaceState } from '@pi-desktop/browser-use/protocol';
import type { CanvasController, CanvasTab } from '@pi-desktop/canvas';
import { useEffect } from 'react';

/** Cap the injected file excerpt so the report (and the model's block) stay tiny. */
const EXCERPT_MAX_CHARS = 240;
/** Coalesce bursts of controller changes (nav settle, tab churn) into one send. */
const REPORT_DEBOUNCE_MS = 250;

type MutableSurface = { -readonly [K in keyof CanvasSurfaceState]: CanvasSurfaceState[K] };

/** Map one canvas tab → the compact surface shape reported to main. */
function surfaceOf(tab: CanvasTab): CanvasSurfaceState {
  const s: MutableSurface = { kind: tab.kind };
  if (tab.title) s.title = tab.title;
  switch (tab.kind) {
    case 'browser': {
      // Report the tab id so main can enrich url/title from the live view — the
      // WebContentsView is keyed by this same controller tab id (native-surfaces).
      s.tabId = tab.id;
      if (tab.url) s.url = tab.url;
      break;
    }
    case 'file':
    case 'code': {
      if (tab.filePath) s.filePath = tab.filePath;
      if (tab.streaming === true) s.dirty = true;
      const text = tab.artifact?.content.text;
      if (typeof text === 'string' && text.length > 0) s.excerpt = text.slice(0, EXCERPT_MAX_CHARS);
      break;
    }
    case 'image':
    case 'pdf': {
      if (tab.mediaType) s.mediaType = tab.mediaType;
      break;
    }
    // terminal / html / svg / markdown / subagent / filetree: kind (+ title) says enough.
  }
  return s;
}

/** Pure: the controller's tab state → the compact canvas snapshot. */
export function toCanvasState(tabs: readonly CanvasTab[], activeTabId: string | null): CanvasState {
  const active = tabs.find((t) => t.id === activeTabId) ?? null;
  const others = tabs.filter((t) => t.id !== active?.id);
  return {
    active: active !== null ? surfaceOf(active) : null,
    others: others.map(surfaceOf),
  };
}

/**
 * Subscribe to the controller and report a debounced canvas snapshot to main on
 * every change (and once on mount). Redundant snapshots (unchanged JSON) are
 * skipped so we don't churn the cache — and, downstream, the model's KV cache.
 */
export function useCanvasStateReporter(controller: CanvasController): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSent = '';
    const send = (): void => {
      timer = null;
      const st = controller.getState();
      const report = toCanvasState(st.tabs, st.activeTabId);
      const json = JSON.stringify(report);
      if (json === lastSent) return;
      lastSent = json;
      void window.piDesktop.invoke('canvas:report-state', { state: report }).catch(() => {});
    };
    const schedule = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(send, REPORT_DEBOUNCE_MS);
    };
    schedule(); // seed main with the initial snapshot
    const unsub = controller.subscribe(schedule);
    return () => {
      unsub();
      if (timer !== null) clearTimeout(timer);
    };
  }, [controller]);
}
