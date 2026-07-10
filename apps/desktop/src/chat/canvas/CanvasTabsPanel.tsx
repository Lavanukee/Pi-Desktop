/**
 * The docked, resizable canvas rail (right side) hosting the TABBED
 * multi-surface `<CanvasTabs>` (THEME 1). Owns rail width (drag-resize) +
 * open/close animation and the collapse ↔ fullscreen affordances (state lives
 * in the shared CanvasController). Artifact-driven tabs are opened by
 * `useArtifactCanvasRouting`; this component only presents the container.
 *
 * ── PHASE 2b: native views (WebContentsView + PTY) ───────────────────────
 * `browser` and `terminal` tabs are LIVE surfaces: the canvas renders their
 * chrome + an empty content slot and hands the app a rect/mount contract.
 * `useNativeSurfaces` (native-surfaces.ts) fulfils that contract — it mounts a
 * per-tab WebContentsView overlay (browser) / xterm.js + PTY (terminal), keyed
 * by (tabId, kind), positioned from the reported element + viewport rect, and
 * destroyed when the tab leaves the controller. This component only presents the
 * container + exposes the controller to the E2E probes.
 */
import { type CanvasTab, CanvasTabs, type NewTabKind, useCanvasTabs } from '@pi-desktop/canvas';
import { IconButton, IconClose } from '@pi-desktop/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CANVAS_MAX_WIDTH, CANVAS_MIN_WIDTH, useCanvasStore } from '../../state/canvas-store';
import { artifactToPayload } from './artifacts';
import { useBrowserAgent } from './browser-agent';
import { useFileWriteCanvasRouting } from './file-tabs';
import { useNativeSurfaces } from './native-surfaces';
import { useSubagentCanvasRouting } from './subagent-routing';
import { useArtifactCanvasRouting } from './tabs-routing';
import { useBashTerminalCanvasRouting } from './terminal-routing';

/** E2E: probes open browser/terminal tabs through the shared controller. Gated
 * on the same `?piE2E=1` opt-in as `window.__pi_store` (see pi-connect.ts). */
const IS_E2E = new URLSearchParams(window.location.search).has('piE2E');

export function CanvasTabsPanel() {
  const { controller, tabs, fullscreen } = useCanvasTabs();
  const sideWidth = useCanvasStore((s) => s.sideWidth);
  const setSideWidth = useCanvasStore((s) => s.setSideWidth);
  // Round-7: the rail's open/closed state is app-owned in the canvas store so the
  // persistent top-right toggle (ChatApp) can open/close it even with no tabs.
  // The in-rail panel-toggle + a newly-routed artifact drive it too. The rail
  // animates its width between `sideWidth` (open) and 0 (slid out).
  const canvasOpen = useCanvasStore((s) => s.canvasOpen);
  const setCanvasOpen = useCanvasStore((s) => s.setCanvasOpen);
  const prevTabCount = useRef(tabs.length);

  // Phase 2b: the real WebContentsView / PTY handlers for the live surfaces.
  const surfaceHandlers = useNativeSurfaces(controller);
  // browser-use: open/focus + register the agent browser tab on request from
  // the main-process bridge, and reflect its "driving" chrome.
  useBrowserAgent(controller);
  // subagents: open/feed the live subagent list tab from the harness-subagents
  // extension status stream (spawn_subagent progress).
  useSubagentCanvasRouting(controller);

  // Keep the canvas in sync with the streamed-artifact detector (THEME 2), the
  // file-write → live file tab router, and the interactive-bash → terminal
  // router (round-7). These run even while the panel renders null (no tabs yet),
  // since it's their job to open the FIRST tab.
  useArtifactCanvasRouting();
  useFileWriteCanvasRouting();
  useBashTerminalCanvasRouting();

  useEffect(() => {
    if (IS_E2E) window.__pi_canvas = () => controller;
  }, [controller]);

  const hasTabs = tabs.length > 0;

  // A newly-opened tab (artifact routed in, a file write, `+`, etc.) opens the
  // rail even if the user had closed it.
  useEffect(() => {
    if (tabs.length > prevTabCount.current) setCanvasOpen(true);
    prevTabCount.current = tabs.length;
  }, [tabs.length, setCanvasOpen]);

  const open = canvasOpen && !fullscreen;

  // Animate the rail width between 0 (closed) and sideWidth (open) — the slide,
  // subject to the reduced-motion rules in global.css. Fullscreen sizes itself.
  const [renderWidth, setRenderWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    setRenderWidth(open ? sideWidth : 0);
  }, [open, sideWidth]);

  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const onHandleDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragState.current = { startX: e.clientX, startWidth: sideWidth };
      setDragging(true);
      const onMove = (ev: MouseEvent) => {
        const st = dragState.current;
        if (st === null) return;
        const next = st.startWidth + (st.startX - ev.clientX);
        setSideWidth(Math.max(CANVAS_MIN_WIDTH, Math.min(CANVAS_MAX_WIDTH, next)));
      };
      const onUp = () => {
        dragState.current = null;
        setDragging(false);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [sideWidth, setSideWidth],
  );

  // Pop the active artifact-backed tab out to the standalone canvas window
  // (the electron `canvas:popout` channel + CanvasPopoutView are already wired).
  const popOut = useCallback((tab: CanvasTab) => {
    if (!tab.artifact) return;
    void window.piDesktop.invoke('canvas:popout', { artifact: artifactToPayload(tab.artifact) });
  }, []);

  // Canvas `+` menu (round-8 #10): open a new file / browser / terminal tab,
  // reusing the existing native-surface mount paths (browser:create, PTY spawn).
  // A `file` tab opens empty and can be filled from the tree panel.
  const onNewTab = useCallback(
    (kind: NewTabKind) => {
      if (kind === 'terminal') controller.openTab({ kind: 'terminal', title: 'Terminal' });
      else if (kind === 'browser') controller.openTab({ kind: 'browser', title: 'New tab' });
      else if (kind === 'subagent')
        controller.upsertTab('pi:subagents', { kind: 'subagent', title: 'Subagents' });
      else controller.openTab({ kind: 'file', title: 'Untitled' });
      setCanvasOpen(true);
    },
    [controller, setCanvasOpen],
  );

  // Clicking a subagent row focuses the (live) subagent tab. Only the summary of
  // each child returns to chat, so there is no separate per-subagent transcript
  // surface to open — focusing keeps the list in view.
  const onSubagentSelect = useCallback(
    (tabId: string) => {
      controller.focusTab(tabId);
      setCanvasOpen(true);
    },
    [controller, setCanvasOpen],
  );

  // Render nothing only when the canvas is both empty AND closed. When the user
  // opens it with no tabs (top-right toggle), the rail shows CanvasTabs' empty
  // state (its `+` opens a browser tab); a routed-in surface fills it.
  if (!open && !hasTabs && !fullscreen) return null;

  // `onCollapse` closes THIS panel (the app slides it out). `onCopy` defaults to
  // the clipboard inside CanvasTabs; the tab-bar Copy button appears for any
  // surface with copyable content (round-5 #20/#21).
  const surface = (
    <CanvasTabs
      handlers={{ ...surfaceHandlers, onSubagentSelect }}
      onNewTab={onNewTab}
      onPopout={popOut}
      onCollapse={() => setCanvasOpen(false)}
      // Round-8 #11/#16: the canvas is only rendered while open, so its top-right
      // toggle shows the X (close). The chat top-bar carries the panel icon that
      // re-opens it when closed — never both at once.
      panelOpen={open}
    />
  );

  // Fullscreen: cover the whole app surface with the tabbed canvas (canvas media
  // "expand"). A close control restores the docked rail.
  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-40 bg-bg-base p-2" data-testid="canvas-tabs-panel">
        <div className="pd-canvas-fullscreen-exit">
          <IconButton
            size="sm"
            aria-label="Exit fullscreen"
            data-testid="canvas-fullscreen-exit"
            onClick={() => controller.setFullscreen(false)}
          >
            <IconClose size={16} />
          </IconButton>
        </div>
        {surface}
      </div>
    );
  }

  return (
    <aside
      className="pd-canvas-rail relative flex h-full shrink-0 flex-col overflow-hidden border-border-subtle border-l bg-bg-raised"
      data-dragging={dragging ? 'true' : undefined}
      data-open={open ? 'true' : 'false'}
      style={{ width: renderWidth }}
      data-testid="canvas-tabs-panel"
    >
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only resize affordance
        <div
          className="pd-canvas-rail-handle absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-accent-primary/40"
          onMouseDown={onHandleDown}
        />
      ) : null}
      {/* Fixed inner width so the surface doesn't reflow while the rail slides. */}
      <div className="min-h-0 flex-1" style={{ width: sideWidth }}>
        {surface}
      </div>
    </aside>
  );
}
