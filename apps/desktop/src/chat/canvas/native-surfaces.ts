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
import { usePiStore } from '../../state/pi-slice';
import { openFileInCanvas } from './file-tabs';

const MONO_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** Same `?piE2E=1` opt-in as the other E2E hooks (pi-connect.ts). */
const IS_E2E = new URLSearchParams(window.location.search).has('piE2E');

/**
 * Invoke a canvas shell-out channel (open-with / reveal / open-external). Under
 * the E2E opt-in it records the call to `window.__pi_canvas_ipc` and SKIPS the
 * real shell-out, so probes can assert the wiring without popping Finder /
 * Terminal / the browser. `window.piDesktop` is a frozen contextBridge object,
 * so a test can't wrap `invoke` itself — hence this seam.
 */
function canvasShellInvoke(channel: 'canvas:open-with', req: { path: string; appId: string }): void;
function canvasShellInvoke(channel: 'canvas:reveal', req: { path: string }): void;
function canvasShellInvoke(channel: 'canvas:open-external', req: { url: string }): void;
function canvasShellInvoke(channel: string, req: unknown): void {
  if (IS_E2E) {
    if (window.__pi_canvas_ipc === undefined) window.__pi_canvas_ipc = [];
    window.__pi_canvas_ipc.push({ channel, req });
    return;
  }
  // biome-ignore lint/suspicious/noExplicitAny: narrowed by the overloads above.
  void window.piDesktop.invoke(channel as any, req as any);
}

interface BrowserEntry {
  lastBounds: BrowserBounds;
}

interface TerminalEntry {
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  spawned: boolean;
  onDataDispose: (() => void) | null;
  /** Mirror tabs render tool-call output (no PTY, read-only); interactive tabs
   * spawn a shell. Decided at first mount from the tab's `data.mirror`. */
  mirror: boolean;
  /** Last mirror text written (skip re-render when unchanged). */
  lastMirrorText: string;
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
  /** Session cwd (project dir), kept fresh by the hook, for the file-tree
   * breadcrumb when the user opens a file from the tree panel. */
  #cwd: string | undefined;

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
      // Browser operation bar: "open in external browser" (trusted-gated in main).
      onBrowserOpenExternal: (tabId) => {
        const url = this.#tab(tabId)?.url;
        if (url) canvasShellInvoke('canvas:open-external', { url });
      },
      // File operation bar: Open ▾ (shell out), Open in folder (reveal), and a
      // file chosen from the tree panel (open/focus its own file tab).
      onOpenWith: (tabId, appId) => {
        const filePath = this.#tab(tabId)?.filePath;
        if (filePath) canvasShellInvoke('canvas:open-with', { path: filePath, appId });
      },
      onReveal: (tabId) => {
        const filePath = this.#tab(tabId)?.filePath;
        if (filePath) canvasShellInvoke('canvas:reveal', { path: filePath });
      },
      onFileTreeSelect: (_tabId, node) => {
        if (node.kind === 'file') void openFileInCanvas(this.#controller, node.path, this.#cwd);
      },
      // Media operation bar: download the current media src / expand to fullscreen.
      onMediaDownload: (tabId, format) => this.#downloadMedia(tabId, format),
      onMediaExpand: (tabId) => {
        const state = this.#controller.getState();
        this.#controller.focusTab(tabId);
        this.#controller.setFullscreen(!state.fullscreen);
      },
    };
  }

  /** Keep the session cwd current (drives the file-tree breadcrumb). */
  setCwd(cwd: string | undefined): void {
    this.#cwd = cwd;
  }

  #tab(tabId: string): CanvasTab | undefined {
    return this.#controller.getState().tabs.find((t) => t.id === tabId);
  }

  /** Download the active media tab's src (data: or http). Anchor-download works
   * for data URIs directly; http(s) srcs are handed to the OS default handler. */
  #downloadMedia(tabId: string, format: string): void {
    const tab = this.#tab(tabId);
    const src = tab?.mediaSrc ?? tab?.artifact?.content.text;
    if (!src) return;
    const name = (tab?.title ?? 'download').replace(/[^\w.-]+/g, '_');
    const filename = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.${format.toLowerCase()}`;
    if (src.startsWith('data:')) {
      const a = document.createElement('a');
      a.href = src;
      a.download = filename;
      a.click();
    } else {
      canvasShellInvoke('canvas:open-external', { url: src });
    }
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
    // A mirror tab renders tool-call output read-only (no shell); an interactive
    // tab spawns a PTY and forwards keystrokes.
    const mirror = this.#tab(tabId)?.data?.mirror === true;
    const term = new Terminal({
      cursorBlink: !mirror,
      disableStdin: mirror,
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
    const onData = mirror
      ? null
      : term.onData((data) => {
          void window.piDesktop.invoke('pty:write', { tabId, data });
        });
    const entry: TerminalEntry = {
      term,
      fit,
      container,
      spawned: false,
      onDataDispose: onData ? () => onData.dispose() : null,
      mirror,
      lastMirrorText: '',
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
      if (entry.mirror) {
        this.#writeMirror(tabId, true);
      } else if (!entry.spawned) {
        entry.spawned = true;
        void window.piDesktop.invoke('pty:spawn', {
          tabId,
          cols: entry.term.cols,
          rows: entry.term.rows,
        });
        entry.term.focus();
      } else {
        entry.term.focus();
      }
    });
  }

  /** Render a mirror terminal's current text into its xterm (reset + rewrite,
   * CRLF-normalised). No-ops when the tab isn't a mirror or the text is
   * unchanged (so a controller tick doesn't flicker the buffer). */
  #writeMirror(tabId: string, force = false): void {
    const entry = this.#terminals.get(tabId);
    if (entry === undefined || !entry.mirror) return;
    const text = (this.#tab(tabId)?.data?.mirrorText as string | undefined) ?? '';
    if (!force && text === entry.lastMirrorText) return;
    entry.lastMirrorText = text;
    entry.term.reset();
    entry.term.write(text.replace(/\r?\n/g, '\r\n'));
  }

  /** Push new mirror text into any mounted mirror terminals (called on each
   * controller change). */
  #syncMirrors(): void {
    for (const [tabId, entry] of this.#terminals) {
      if (entry.mirror && entry.container.parentNode !== null) this.#writeMirror(tabId);
    }
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
        entry.onDataDispose?.();
        entry.term.dispose();
        // Mirror terminals never spawned a PTY; kill is a no-op for them.
        if (!entry.mirror) void window.piDesktop.invoke('pty:kill', { tabId });
      }
    }
    // Push any updated tool-call output into mounted mirror terminals.
    this.#syncMirrors();
  }

  disposeAll(): void {
    for (const [tabId] of this.#browsers)
      void window.piDesktop.invoke('browser:destroy', { tabId });
    this.#browsers.clear();
    for (const [tabId, entry] of this.#terminals) {
      entry.onDataDispose?.();
      entry.term.dispose();
      if (!entry.mirror) void window.piDesktop.invoke('pty:kill', { tabId });
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

  // Keep the session cwd fresh (the file-tree "Open from tree" breadcrumb).
  const cwd = usePiStore((s) => s.session?.cwd ?? undefined);
  manager.setCwd(cwd);

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
