/**
 * Phase 2b native-surface wiring: the renderer half of the browser/terminal
 * live surfaces. `useNativeSurfaces(controller)` returns the `CanvasTabsHandlers`
 * bag the tabbed canvas hands to BrowserSurface / TerminalSurface, and drives
 * the main-process managers (electron/canvas/browser-manager.ts,
 * electron/terminal/pty-manager.ts) over the `browser:*` / `pty:*` channels.
 *
 * Contract followed (packages/canvas surfaces/content-slot.ts):
 *   - onSurfaceMount(id, kind, el)      el = the content slot; null = HIDE.
 *   - onSurfaceRectChange(id, kind, r)  viewport rect (client coords) or null.
 * Browser tabs are a native WebContentsView OVERLAY main positions from the
 * reported rect (client rect ↔ window content coords are 1:1 for the main
 * window). Terminal tabs mount an xterm.js instance INTO the slot, backed by a
 * PTY in main. Mount/unmount HIDES (never destroys) on tab-switch; a view/PTY
 * is destroyed only when its tab id leaves controller.getState().tabs.
 *
 * "Model drives the browser" seam: main exports browserManager
 * (navigate/capture/snapshotDom/click); a future browser-use tool set flips the
 * chrome indicator with controller.updateTab({ driving: true }).
 */
import '@xterm/xterm/css/xterm.css';
import type { CanvasController, CanvasTab, CanvasTabsHandlers } from '@pi-desktop/canvas';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import type { BrowserBounds } from '../../../electron/canvas/browser-contract';

const MONO_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

interface BrowserEntry {
  lastBounds: BrowserBounds;
}

interface TerminalEntry {
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  spawned: boolean;
  onDataDispose: () => void;
}

function rectToBounds(rect: DOMRect): BrowserBounds {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/** Owns the per-tab native views/PTYs for one window. One instance per panel. */
class NativeSurfaces {
  readonly handlers: CanvasTabsHandlers;
  readonly #controller: CanvasController;
  readonly #browsers = new Map<string, BrowserEntry>();
  readonly #terminals = new Map<string, TerminalEntry>();

  constructor(controller: CanvasController) {
    this.#controller = controller;
    this.handlers = {
      onSurfaceMount: (tabId, kind, el) => this.#onMount(tabId, kind, el),
      onSurfaceRectChange: (tabId, kind, rect) => this.#onRect(tabId, kind, rect),
      onBrowserNavigate: (tabId, url) => {
        this.#controller.updateTab(tabId, { url, loading: true });
        void window.piDesktop.invoke('browser:navigate', { tabId, url });
      },
      onBrowserBack: (tabId) => void window.piDesktop.invoke('browser:back', { tabId }),
      onBrowserForward: (tabId) => void window.piDesktop.invoke('browser:forward', { tabId }),
      onBrowserReload: (tabId) => void window.piDesktop.invoke('browser:reload', { tabId }),
    };
  }

  // ── mount / rect ─────────────────────────────────────────────────────────
  #onMount(tabId: string, kind: CanvasTab['kind'], el: HTMLElement | null): void {
    if (kind === 'browser') {
      if (el !== null) void window.piDesktop.invoke('browser:create', { tabId });
      else this.#hideBrowser(tabId);
      return;
    }
    if (kind === 'terminal') {
      if (el !== null) this.#mountTerminal(tabId, el);
      else this.#detachTerminal(tabId);
    }
  }

  #onRect(tabId: string, kind: CanvasTab['kind'], rect: DOMRect | null): void {
    if (kind === 'browser') {
      if (rect === null) {
        this.#hideBrowser(tabId);
        return;
      }
      const bounds = rectToBounds(rect);
      this.#browsers.set(tabId, { lastBounds: bounds });
      void window.piDesktop.invoke('browser:set-bounds', { tabId, bounds, visible: true });
      return;
    }
    if (kind === 'terminal' && rect !== null) this.#fitTerminal(tabId);
  }

  // ── browser ──────────────────────────────────────────────────────────────
  #hideBrowser(tabId: string): void {
    const bounds = this.#browsers.get(tabId)?.lastBounds ?? { x: 0, y: 0, width: 0, height: 0 };
    void window.piDesktop.invoke('browser:set-bounds', { tabId, bounds, visible: false });
  }

  applyBrowserState(patch: {
    tabId: string;
    url?: string;
    title?: string;
    loading?: boolean;
    canGoBack?: boolean;
    canGoForward?: boolean;
    faviconUrl?: string;
  }): void {
    const { tabId, faviconUrl, ...rest } = patch;
    const tab = this.#controller.getState().tabs.find((t) => t.id === tabId);
    if (tab === undefined) return;
    const next: Partial<Omit<CanvasTab, 'id'>> = {};
    if (rest.url !== undefined) next.url = rest.url;
    if (rest.title !== undefined && rest.title !== '') next.title = rest.title;
    if (rest.loading !== undefined) next.loading = rest.loading;
    if (rest.canGoBack !== undefined) next.canGoBack = rest.canGoBack;
    if (rest.canGoForward !== undefined) next.canGoForward = rest.canGoForward;
    if (faviconUrl !== undefined) next.data = { ...tab.data, faviconUrl };
    this.#controller.updateTab(tabId, next);
  }

  // ── terminal ───────────────────────────────────────────────────────────────
  #ensureTerminal(tabId: string): TerminalEntry {
    const existing = this.#terminals.get(tabId);
    if (existing !== undefined) return existing;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: MONO_STACK,
      fontSize: 13,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const container = document.createElement('div');
    container.style.width = '100%';
    container.style.height = '100%';
    term.open(container);
    const onData = term.onData((data) => {
      void window.piDesktop.invoke('pty:write', { tabId, data });
    });
    const entry: TerminalEntry = {
      term,
      fit,
      container,
      spawned: false,
      onDataDispose: () => onData.dispose(),
    };
    this.#terminals.set(tabId, entry);
    return entry;
  }

  #mountTerminal(tabId: string, el: HTMLElement): void {
    const entry = this.#ensureTerminal(tabId);
    el.appendChild(entry.container);
    // Give the slot a layout pass before fitting so cols/rows are real.
    requestAnimationFrame(() => {
      this.#fitTerminal(tabId);
      if (!entry.spawned) {
        entry.spawned = true;
        void window.piDesktop.invoke('pty:spawn', {
          tabId,
          cols: entry.term.cols,
          rows: entry.term.rows,
        });
      }
      entry.term.focus();
    });
  }

  #detachTerminal(tabId: string): void {
    const entry = this.#terminals.get(tabId);
    if (entry?.container.parentNode) entry.container.parentNode.removeChild(entry.container);
  }

  #fitTerminal(tabId: string): void {
    const entry = this.#terminals.get(tabId);
    if (entry === undefined || entry.container.parentNode === null) return;
    try {
      entry.fit.fit();
    } catch {
      return; // container not measurable yet
    }
    void window.piDesktop.invoke('pty:resize', {
      tabId,
      cols: entry.term.cols,
      rows: entry.term.rows,
    });
  }

  applyPtyData(payload: { tabId: string; data: string }): void {
    this.#terminals.get(payload.tabId)?.term.write(payload.data);
  }

  applyPtyExit(payload: { tabId: string; exitCode: number | null }): void {
    const code = payload.exitCode ?? 0;
    this.#terminals
      .get(payload.tabId)
      ?.term.write(`\r\n\x1b[90m[process exited (${code})]\x1b[0m\r\n`);
  }

  // ── reconcile: destroy views/PTYs whose tab left the controller ───────────
  syncTabs(): void {
    const live = new Set(this.#controller.getState().tabs.map((t) => t.id));
    for (const tabId of [...this.#browsers.keys()]) {
      if (!live.has(tabId)) {
        this.#browsers.delete(tabId);
        void window.piDesktop.invoke('browser:destroy', { tabId });
      }
    }
    for (const [tabId, entry] of [...this.#terminals]) {
      if (!live.has(tabId)) {
        this.#terminals.delete(tabId);
        entry.onDataDispose();
        entry.term.dispose();
        void window.piDesktop.invoke('pty:kill', { tabId });
      }
    }
  }

  disposeAll(): void {
    for (const [tabId] of this.#browsers)
      void window.piDesktop.invoke('browser:destroy', { tabId });
    this.#browsers.clear();
    for (const [tabId, entry] of this.#terminals) {
      entry.onDataDispose();
      entry.term.dispose();
      void window.piDesktop.invoke('pty:kill', { tabId });
    }
    this.#terminals.clear();
  }
}

/**
 * Wire the native-surface managers for the panel: subscribes to the controller
 * (tab-removal → destroy) and to the `browser:*` / `pty:*` event streams, and
 * returns the stable handlers bag for `<CanvasTabs handlers={…}>`.
 */
export function useNativeSurfaces(controller: CanvasController): CanvasTabsHandlers {
  const ref = useRef<NativeSurfaces | null>(null);
  if (ref.current === null) ref.current = new NativeSurfaces(controller);
  const manager = ref.current;

  useEffect(() => {
    const unsubController = controller.subscribe(() => manager.syncTabs());
    const unsubBrowser = window.piDesktop.onEvent('browser:state', (p) =>
      manager.applyBrowserState(p),
    );
    const unsubData = window.piDesktop.onEvent('pty:data', (p) => manager.applyPtyData(p));
    const unsubExit = window.piDesktop.onEvent('pty:exit', (p) => manager.applyPtyExit(p));
    return () => {
      unsubController();
      unsubBrowser();
      unsubData();
      unsubExit();
      manager.disposeAll();
    };
  }, [controller, manager]);

  return manager.handlers;
}
