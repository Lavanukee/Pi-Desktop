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
import { type ITheme, Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef } from 'react';
import type { BrowserBounds } from '../../../electron/canvas/browser-contract';
import { usePiStore } from '../../state/pi-slice';
import { browserBoundsForPanel, rectToBounds } from './browser-bounds';
import { fileArtifactFromText, openFileInCanvas } from './file-tabs';

const MONO_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** Read a --pd-* theme token off the document root, falling back when unset. */
function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * xterm theme derived from the app's `--pd-*` tokens (round-10 #5) so the
 * terminal reads as part of the app instead of a raw black box: background +
 * foreground + a subtle accent cursor + selection all come from the theme.
 */
function terminalTheme(): ITheme {
  const bg = cssVar('--pd-code-block-bg', '#1e1e24');
  const fg = cssVar('--pd-text-primary', '#e6e6ea');
  const accent = cssVar('--pd-accent-primary', '#8aa2ff');
  const muted = cssVar('--pd-text-muted', '#9aa0a6');
  const selection = cssVar('--pd-bg-selected', 'rgba(138,162,255,0.28)');
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: selection,
    black: bg,
    brightBlack: muted,
  };
}

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
  /** Last fitted grid size — a scroll/focus/blur re-fires the slot's rect
   * callback without a real resize, so we skip the pty:resize when unchanged. */
  lastCols: number;
  lastRows: number;
}

/** Owns the per-tab native views/PTYs for one window. One instance per panel. */
export class NativeSurfaces {
  readonly handlers: CanvasTabsHandlers;
  readonly #controller: CanvasController;
  readonly #browsers = new Map<string, BrowserEntry>();
  readonly #terminals = new Map<string, TerminalEntry>();
  /** Session cwd (project dir), kept fresh by the hook, for the file-tree
   * breadcrumb when the user opens a file from the tree panel. */
  #cwd: string | undefined;
  /**
   * Whether the canvas panel is OPEN. Native browser views paint ABOVE the DOM
   * and are NOT clipped by the collapsing aside, so a rect callback that fired
   * `visible:true` while the panel is closed would strand the view over the chat
   * (round-14 close bug). Every rect emit honours this, and `setPanelOpen`
   * hides/re-shows on the open→closed / closed→open edge.
   */
  #panelOpen = true;

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
      // File operation bar split button: "Open" opens with the OS DEFAULT app
      // (round-8 #14 — the same handler the default-app icon labels), while the
      // ▾ dropdown's "Open with" picks a specific app id (bundle id / .app path).
      onOpen: (tabId) => {
        const filePath = this.#tab(tabId)?.filePath;
        if (filePath) canvasShellInvoke('canvas:open-with', { path: filePath, appId: 'default' });
      },
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
      // Persist the raw↔rendered choice on the tab so it survives tab switches
      // (round-8 #6/#13); the canvas seeds its toggle from `tab.rawRendered`.
      onFileViewModeChange: (tabId, mode) => {
        this.#controller.updateTab(tabId, { rawRendered: mode });
      },
      // Live editing: persist the raw editor's buffer to disk (round-9). The
      // main-process handler fences the path to allowed project/session roots.
      onFileSave: (tabId, text) => this.#saveFile(tabId, text),
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

  /**
   * Persist the raw editor's buffer to the tab's file (round-9 live editing).
   * The main-process `fs:write-file` handler fences the path to allowed
   * project/session roots. On success we reflect the saved text on the tab so it
   * survives tab switches AND the finalize-from-disk reload (both read the same
   * bytes now on disk). Under E2E the real IPC is skipped — the call is recorded
   * to `window.__pi_canvas_ipc` and the tab is updated so probes can assert both.
   */
  #saveFile(tabId: string, text: string): void {
    const tab = this.#tab(tabId);
    const filePath = tab?.filePath;
    if (filePath === undefined) return;
    const reflect = (): void => {
      const current = this.#tab(tabId);
      if (current !== undefined)
        this.#controller.updateTab(tabId, { artifact: fileArtifactFromText(filePath, text) });
    };
    if (IS_E2E) {
      if (window.__pi_canvas_ipc === undefined) window.__pi_canvas_ipc = [];
      window.__pi_canvas_ipc.push({ channel: 'fs:write-file', req: { path: filePath, text } });
      reflect();
      return;
    }
    void window.piDesktop
      .invoke('fs:write-file', { path: filePath, content: text })
      .then((res) => {
        if (res.ok) reflect();
      })
      .catch(() => {
        // best-effort — a failed write leaves the on-screen buffer untouched.
      });
  }

  // ── mount / rect ─────────────────────────────────────────────────────────
  #onMount(tabId: string, kind: CanvasTab['kind'], el: HTMLElement | null): void {
    if (kind === 'browser') {
      if (el !== null) {
        void window.piDesktop.invoke('browser:create', { tabId }).then((res) => {
          // A browser tab restored from a per-chat snapshot re-creates a BLANK
          // WebContentsView; nothing else reacts to `tab.url`. On FIRST creation
          // only (idempotent create ⇒ never on a same-session re-mount, so in-tab
          // navigation is preserved), navigate the fresh view back to its URL.
          if (res.created !== true) return;
          const url = this.#tab(tabId)?.url;
          if (url !== undefined && url.length > 0) {
            void window.piDesktop.invoke('browser:navigate', { tabId, url });
          }
        });
      } else this.#hideBrowser(tabId);
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
      // Only show the view while the panel is open — a stray scroll/resize emit
      // must not re-strand it over the chat after the canvas has been closed.
      void window.piDesktop.invoke('browser:set-bounds', {
        tabId,
        bounds,
        visible: this.#panelOpen,
      });
      return;
    }
    if (kind === 'terminal' && rect !== null) this.#fitTerminal(tabId);
  }

  // ── browser ──────────────────────────────────────────────────────────────
  #hideBrowser(tabId: string): void {
    const bounds = this.#browsers.get(tabId)?.lastBounds ?? { x: 0, y: 0, width: 0, height: 0 };
    void window.piDesktop.invoke('browser:set-bounds', { tabId, bounds, visible: false });
  }

  /**
   * A canvas DOM menu (the `+` new-tab menu) opened/closed (round-10 #2). A live
   * browser WebContentsView paints ABOVE the DOM, so it would occlude the menu on
   * a browser tab — hide the ACTIVE browser view while the menu is up and re-show
   * it on close. Stateless: keyed off the currently-active tab each call, so a
   * pick that switches tabs leaves visibility to the normal mount/rect path.
   */
  setOverlayOpen(open: boolean): void {
    const activeId = this.#controller.getState().activeTabId;
    if (activeId === null) return;
    const tab = this.#tab(activeId);
    if (tab?.kind !== 'browser') return;
    const entry = this.#browsers.get(tab.id);
    if (entry === undefined) return;
    void window.piDesktop.invoke('browser:set-bounds', {
      tabId: tab.id,
      bounds: entry.lastBounds,
      // Never raise the view while the whole panel is closed.
      visible: !open && this.#panelOpen,
    });
  }

  /**
   * The canvas panel opened / closed (round-14 close bug). Closing the canvas
   * must fully hide EVERY native browser view — they paint over the DOM and are
   * not clipped by the collapsing aside, so without this they float, stranded,
   * over the chat column after close. Reopening re-shows only the ACTIVE browser
   * tab at its last bounds (the surface never unmounted, so the rect path can't
   * do it). The `#onRect` emit also honours `#panelOpen`, so a stray
   * scroll/resize while closed can't re-strand a view.
   */
  setPanelOpen(open: boolean): void {
    this.#panelOpen = open;
    const activeId = this.#controller.getState().activeTabId;
    for (const intent of browserBoundsForPanel(open, activeId, this.#browsers)) {
      void window.piDesktop.invoke('browser:set-bounds', intent);
    }
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
      // A thin bar cursor (not the default chunky block) + the app theme so the
      // terminal matches the rest of the app (round-10 #5).
      cursorStyle: 'bar',
      cursorWidth: 2,
      disableStdin: mirror,
      fontFamily: cssVar('--pd-font-mono', MONO_STACK),
      fontSize: 13,
      lineHeight: 1.2,
      allowProposedApi: true,
      theme: terminalTheme(),
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
      lastCols: 0,
      lastRows: 0,
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
        // Start the shell in the active project's cwd (round-10 #5) — the same
        // folder pi runs in — not the OS home default. `#cwd` is the live session
        // cwd (respawned to the project path when a project is active).
        void window.piDesktop.invoke('pty:spawn', {
          tabId,
          cols: entry.term.cols,
          rows: entry.term.rows,
          cwd: this.#cwd,
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
    // Skip when the measured grid is unchanged: a scroll / focus / blur re-fires
    // the slot's onRectChange (→ this) without any real resize, and re-issuing
    // pty:resize on every such event churns the terminal for no reason.
    if (entry.term.cols === entry.lastCols && entry.term.rows === entry.lastRows) return;
    entry.lastCols = entry.term.cols;
    entry.lastRows = entry.term.rows;
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

/** What {@link useNativeSurfaces} returns: the handlers bag for `<CanvasTabs>`
 * plus the overlay-open seam that hides a native browser view while a DOM menu
 * is up (round-10 #2). */
export interface NativeSurfacesApi {
  handlers: CanvasTabsHandlers;
  /** The `+` new-tab menu opened/closed — lower/raise the active browser view. */
  setOverlayOpen: (open: boolean) => void;
  /** The canvas panel opened/closed — hide every native browser view on close,
   * re-show the active one on open (round-14 close bug). */
  setPanelOpen: (open: boolean) => void;
}

/**
 * Wire the native-surface managers for the panel: subscribes to the controller
 * (tab-removal → destroy) and to the `browser:*` / `pty:*` event streams, and
 * returns the stable handlers bag for `<CanvasTabs handlers={…}>` plus the
 * overlay-open seam.
 */
export function useNativeSurfaces(controller: CanvasController): NativeSurfacesApi {
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

  // Stable callbacks (the manager is created once) so effects keyed on them
  // don't re-fire every render.
  const setOverlayOpen = useCallback((open: boolean) => manager.setOverlayOpen(open), [manager]);
  const setPanelOpen = useCallback((open: boolean) => manager.setPanelOpen(open), [manager]);
  return { handlers: manager.handlers, setOverlayOpen, setPanelOpen };
}
