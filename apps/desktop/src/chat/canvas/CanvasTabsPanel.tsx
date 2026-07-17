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
import type { ArtifactRef, OrgNodeView } from '@pi-desktop/coordination';
import { IconButton, IconClose } from '@pi-desktop/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCanvasStore } from '../../state/canvas-store';
import { useCorpStore } from '../../state/corp-store';
import { usePiStore } from '../../state/pi-slice';
import { artifactToPayload } from './artifacts';
import { useBrowserAgent } from './browser-agent';
import { useCanvasStateReporter } from './canvas-state-report';
import { openProjectFileTree, useFileTabRefresh, useFileWriteCanvasRouting } from './file-tabs';
import { useNativeSurfaces } from './native-surfaces';
import { createCanvasDragResize } from './resize-collapse';
import { useSubagentCanvasRouting } from './subagent-routing';
import { useArtifactCanvasRouting } from './tabs-routing';
import { useBashTerminalCanvasRouting } from './terminal-routing';
import { useGen } from './useGen';

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
  // The active project / session cwd — where a new terminal or the Files tree
  // surface should be rooted (round-10 #4/#5).
  const cwd = usePiStore((s) => s.session?.cwd ?? undefined);
  const prevTabCount = useRef(tabs.length);

  // Phase 2b: the real WebContentsView / PTY handlers for the live surfaces, plus
  // the overlay-open seam that lowers a native browser view while the `+` menu is
  // up (round-10 #2 — the view otherwise paints over the DOM menu).
  const { handlers: surfaceHandlers, setOverlayOpen, setPanelOpen } = useNativeSurfaces(controller);
  // browser-use: open/focus + register the agent browser tab on request from
  // the main-process bridge, and reflect its "driving" chrome.
  useBrowserAgent(controller);
  // generation (experimental): stream `generate_image`/`generate_video` jobs into
  // a live gen-image canvas tab. Inert unless the generation flag / `?gen=1` is on.
  useGen(controller);
  // Canvas-awareness: report a compact snapshot of what's on the canvas to main
  // on every surface / active-tab change, so the model's `context` hook always
  // knows what the user is looking at (jedd's gotcha).
  useCanvasStateReporter(controller);
  // subagents: open/feed the live subagent list tab from the harness-subagents
  // extension status stream (spawn_subagent progress).
  useSubagentCanvasRouting(controller);

  // Keep the canvas in sync with the streamed-artifact detector (THEME 2), the
  // file-write → live file tab router, and the interactive-bash → terminal
  // router (round-7). These run even while the panel renders null (no tabs yet),
  // since it's their job to open the FIRST tab.
  useArtifactCanvasRouting();
  useFileWriteCanvasRouting();
  // Recover a focused file tab that raced its write and rendered blank (round-
  // blindtest #10) — re-reads from disk when an EMPTY file tab gains focus.
  useFileTabRefresh();
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
  // Round-14 (#8): the live per-frame width during a resize drag. Tracks the
  // cursor both directions (data-dragging disables the transition) and may shrink
  // below the minimum toward 0 for a provisional-collapse preview; null when idle
  // so the `renderWidth` effect resumes ownership.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  useEffect(() => {
    setRenderWidth(open ? sideWidth : 0);
  }, [open, sideWidth]);

  // Round-14 close bug: a native browser WebContentsView paints ABOVE the DOM and
  // is NOT clipped by the aside sliding to width 0, so closing the canvas would
  // leave the browser stranded over the chat. Drive the native views' visibility
  // off the panel's open state — hide every browser view on close, re-show the
  // active one on open. (The DOM aside already animates to 0 and the chat column
  // reclaims the width; this closes the native-overlay half of the same close.)
  useEffect(() => {
    setPanelOpen(open);
  }, [open, setPanelOpen]);

  // Round-11 (#2): keep the rail MOUNTED through its slide-OUT so closing an
  // EMPTY canvas animates (width → 0) instead of vanishing. A closed-but-tabbed
  // rail already stays mounted (`hasTabs`, so its tabs survive — the round-8
  // slide). For the empty case we hold an `exiting` flag for the exit duration
  // (> the width transition; reduced-motion safe) so the node lingers while it
  // slides, then unmounts. Reopening mid-exit clears it. The width transition
  // itself (both directions) is driven by `renderWidth` above.
  const shown = open || hasTabs;
  const [exiting, setExiting] = useState(false);
  const prevShown = useRef(shown);
  useEffect(() => {
    const wasShown = prevShown.current;
    prevShown.current = shown;
    if (shown) {
      setExiting(false);
      return;
    }
    if (wasShown) {
      setExiting(true);
      const t = window.setTimeout(() => setExiting(false), 400);
      return () => window.clearTimeout(t);
    }
  }, [shown]);

  const dragActive = useRef(false);
  const onHandleDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragActive.current = true;
      setDragging(true);
      const cleanup = () => {
        dragActive.current = false;
        setDragging(false);
        setDragWidth(null);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      // Round-14 (#8): the gesture PREVIEWS on move (live `dragWidth`, persisting
      // only above min) and COMMITS the close ONCE on release — the panel is no
      // longer torn down mid-drag, so dragging back past the threshold un-collapses.
      const drag = createCanvasDragResize(e.clientX, sideWidth, {
        setSideWidth,
        // Mirror the live preview into `renderWidth` so that when the drag ends
        // the animated width picks up from the RELEASE position instead of a
        // stale open width. Without this, a drag-close first snaps the rail back
        // to its (still-open) width for a frame before sliding shut — the panel
        // now animates smoothly from where the cursor left it down to 0.
        setDragWidth: (w) => {
          setDragWidth(w);
          if (w !== null) setRenderWidth(w);
        },
        setCanvasOpen,
        cleanup,
      });
      const onMove = (ev: MouseEvent) => {
        if (!dragActive.current) return;
        drag.move(ev.clientX);
      };
      const onUp = () => drag.up();
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [sideWidth, setSideWidth, setCanvasOpen],
  );

  // Pop the active artifact-backed tab out to the standalone canvas window
  // (the electron `canvas:popout` channel + CanvasPopoutView are already wired).
  const popOut = useCallback((tab: CanvasTab) => {
    if (!tab.artifact) return;
    void window.piDesktop.invoke('canvas:popout', { artifact: artifactToPayload(tab.artifact) });
  }, []);

  // Canvas `+` menu (round-8 #10): open a new browser / terminal / subagent tab,
  // reusing the existing native-surface mount paths (browser:create, PTY spawn).
  // `filetree` (round-10 #4) opens the full-canvas project file tree — NOT a
  // blank "untitled" file (the previous bug).
  const onNewTab = useCallback(
    (kind: NewTabKind) => {
      if (kind === 'terminal') controller.openTab({ kind: 'terminal', title: 'Terminal' });
      else if (kind === 'browser') controller.openTab({ kind: 'browser', title: 'New tab' });
      else if (kind === 'subagent')
        controller.upsertTab('pi:subagents', { kind: 'subagent', title: 'Subagents' });
      else if (kind === 'filetree') void openProjectFileTree(controller, cwd);
      setCanvasOpen(true);
    },
    [controller, cwd, setCanvasOpen],
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

  // EXPERIMENTAL production harness: clicking a worker node in the situation room
  // routes its REAL stream into the LEFT chat area (via the corp store, read by
  // ChatApp) and highlights the node in the room. Inert unless a corp run is on.
  const onSituationNodeSelect = useCallback(
    (tabId: string, node: OrgNodeView) => {
      useCorpStore.getState().selectNode(node);
      controller.updateTab(tabId, {
        situationSelectedNodeId: useCorpStore.getState().selectedNode?.id,
      });
    },
    [controller],
  );

  // "Peek at the build": open the current best artifact in its own tab.
  const onSituationPeek = useCallback(
    (_tabId: string, artifact: ArtifactRef) => {
      controller.upsertTab(`situation-peek:${artifact.id}`, {
        kind: 'html',
        title: 'Build snapshot',
        artifact: {
          id: `peek-${artifact.id}`,
          title: artifact.title,
          content: {
            kind: 'html',
            text: `<!doctype html><meta charset="utf-8"><body style="font:14px/1.6 system-ui;padding:24px;color:#ddd;background:#1a1a1a"><h2>${artifact.title}</h2><p>A snapshot of the build so far.</p></body>`,
          },
        },
      });
      setCanvasOpen(true);
    },
    [controller, setCanvasOpen],
  );

  // Render nothing only once the closed rail has finished sliding out AND has no
  // tabs to preserve (`exiting` holds it through the exit transition above).
  // When the user opens it with no tabs (top-right toggle), the rail shows
  // CanvasTabs' empty state — the 4 new-tab options (Files / Browser / Terminal /
  // Subagents) presented directly, each routed through `onNewTab`; a routed-in
  // surface fills it.
  if (!shown && !exiting && !fullscreen) return null;

  // `onCollapse` closes THIS panel (the app slides it out). `onCopy` defaults to
  // the clipboard inside CanvasTabs; the tab-bar Copy button appears for any
  // surface with copyable content (round-5 #20/#21).
  const surface = (
    <CanvasTabs
      handlers={{ ...surfaceHandlers, onSubagentSelect, onSituationNodeSelect, onSituationPeek }}
      onNewTab={onNewTab}
      onMenuOpenChange={setOverlayOpen}
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

  // While dragging, track the live preview width (both directions, below min
  // toward 0); otherwise the animated `renderWidth` owns it. data-dragging
  // disables the transition so the drag tracks the cursor 1:1.
  const shownWidth = dragging && dragWidth !== null ? dragWidth : renderWidth;

  return (
    <aside
      className="pd-canvas-rail relative flex h-full shrink-0 flex-col overflow-hidden bg-bg-raised"
      data-dragging={dragging ? 'true' : undefined}
      data-open={open ? 'true' : 'false'}
      style={{ width: shownWidth }}
      data-testid="canvas-tabs-panel"
    >
      {open ? (
        // Resize grip (round-11 #4a, refined round-16): a thin divider line + a
        // small CENTRED 3-dot grip (not a scrollbar-like pill), stepping up to a
        // subtle neutral tone on hover/drag. The hit area is wider than the
        // visible line for a comfortable col-resize grab. Styling lives in
        // `.pd-canvas-rail-handle` (canvas styles.css).
        // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only resize affordance
        <div
          className="pd-canvas-rail-handle"
          data-dragging={dragging ? 'true' : undefined}
          data-testid="canvas-rail-handle"
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
