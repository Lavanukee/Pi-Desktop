import {
  IconButton,
  IconCheck,
  IconClose,
  IconCopy,
  IconGlobe,
  IconPlus,
  IconTerminal,
} from '@pi-desktop/ui';
import {
  type ComponentType,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { type CanvasConfig, CanvasConfigContext, defaultCanvasConfig } from '../context.ts';
import type { ArtifactContent } from '../model.ts';
import { defaultSurfaceRegistry, type SurfaceRegistry } from '../registry.ts';
import { BrowserSurface } from '../surfaces/browser-surface.tsx';
import { CodeSurface, rawSourceContent } from '../surfaces/code-surface.tsx';
import { FileSurface } from '../surfaces/file-surface.tsx';
import { MediaPreviewSurface } from '../surfaces/media-preview-surface.tsx';
import { ensureDefaultSurfaces } from '../surfaces/register-builtins.tsx';
import { SubagentSurface } from '../surfaces/subagent-surface.tsx';
import { TerminalSurface } from '../surfaces/terminal-surface.tsx';
import { IconFolder, IconPanelRight, IconPopout, IconSubagent } from '../tab-icons.tsx';
import { CanvasOperationBar, hasViewToggle, viewModeDefault } from './canvas-operation-bar.tsx';
import type { CanvasController } from './controller.ts';
import { FileTree } from './file-tree.tsx';
import { CANVAS_TAB_KINDS } from './tab-kinds.ts';
import type { CanvasTab, FileTreeNode, FileViewMode } from './tab-model.ts';
import { useCanvasTabs } from './use-canvas-tabs.tsx';
import { useOutsideClose } from './use-outside-close.ts';

/** The tab kinds the `+` menu can open. `filetree` opens the full-canvas project
 * file tree (NOT a blank "untitled" file — round-10 #4); `subagent` opens the
 * live subagent list surface (the app also opens/feeds it as children spawn). */
export type NewTabKind = 'filetree' | 'browser' | 'terminal' | 'subagent';

/** The `+` menu rows: kind, label, optional shortcut hint, and type glyph. */
const NEW_TAB_ITEMS: ReadonlyArray<{
  kind: NewTabKind;
  label: string;
  hint?: string;
  icon: ComponentType<{ size?: number }>;
}> = [
  { kind: 'filetree', label: 'Files', hint: '⌘P', icon: IconFolder },
  { kind: 'browser', label: 'Browser', hint: '⌘T', icon: IconGlobe },
  { kind: 'terminal', label: 'Terminal', icon: IconTerminal },
  { kind: 'subagent', label: 'Subagents', icon: IconSubagent },
];

/** One entry of {@link NEW_TAB_ITEMS}. */
type NewTabItem = (typeof NEW_TAB_ITEMS)[number];

/**
 * ONE full-width interactive row for a new-tab action, shared by BOTH the `+`
 * dropdown and the empty-state list so the two can never drift (they map over
 * the same {@link NEW_TAB_ITEMS}). The ENTIRE row is a single button: icon +
 * label on the left, the optional ⌘P/⌘T shortcut right-aligned INSIDE the same
 * clickable element — the shortcut cell and the trailing whitespace are part of
 * the hit target, so there is no dead zone on the right (round-14 canvas wave).
 * `className` selects the context look; the dropdown passes `role="menuitem"`.
 */
function NewTabActionRow({
  item,
  className,
  role,
  onPick,
}: {
  item: NewTabItem;
  className: string;
  role?: 'menuitem';
  onPick: (kind: NewTabKind) => void;
}) {
  const Icon = item.icon;
  return (
    <button type="button" role={role} className={className} onClick={() => onPick(item.kind)}>
      <span className="pd-menu-icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <span className="pd-canvas-action-label">{item.label}</span>
      {item.hint ? <span className="pd-menu-hint">{item.hint}</span> : null}
    </button>
  );
}

/**
 * The app-supplied wiring for LIVE surfaces (browser/terminal native views,
 * media downloads, subagent selection), all keyed by `tabId` (+ `kind` for the
 * shared mount/rect slot). The app routes these to per-tab WebContentsView / PTY
 * management. Everything is optional so the tabbed canvas renders standalone.
 */
export interface CanvasTabsHandlers {
  onBrowserNavigate?: (tabId: string, url: string) => void;
  onBrowserBack?: (tabId: string) => void;
  onBrowserForward?: (tabId: string) => void;
  onBrowserReload?: (tabId: string) => void;
  /** "Open in external browser" control in the browser operation bar. */
  onBrowserOpenExternal?: (tabId: string) => void;
  onBrowserMenu?: (tabId: string) => void;
  /** Slot element for a browser/terminal tab mounted (null on unmount/hide). */
  onSurfaceMount?: (tabId: string, kind: CanvasTab['kind'], element: HTMLElement | null) => void;
  /** Slot viewport rect for a browser/terminal tab (null on unmount). */
  onSurfaceRectChange?: (tabId: string, kind: CanvasTab['kind'], rect: DOMRect | null) => void;
  onMediaDownload?: (tabId: string, format: string) => void;
  onMediaRefresh?: (tabId: string) => void;
  onMediaExpand?: (tabId: string) => void;
  onSubagentSelect?: (tabId: string, subagentId: string) => void;
  /** File split button — primary "Open" segment (open with the tab's default app). */
  onOpen?: (tabId: string) => void;
  /** File split button — a specific app chosen from the "Open with" dropdown. */
  onOpenWith?: (tabId: string, appId: string) => void;
  /** File operation bar — "Open in folder" (reveal the file in the OS shell). */
  onReveal?: (tabId: string) => void;
  /** File operation bar — a file chosen from the toggleable file-tree panel. */
  onFileTreeSelect?: (tabId: string, node: FileTreeNode) => void;
  /** File operation bar — the raw↔rendered toggle changed (persist per-tab). */
  onFileViewModeChange?: (tabId: string, mode: FileViewMode) => void;
  /** Raw editor save-back (⌘/Ctrl-S) — persist the edited buffer of a file tab
   * to disk. The app fences + writes via `fs:write-file`; omit to keep read-only. */
  onFileSave?: (tabId: string, text: string) => void;
}

export interface CanvasTabsProps {
  /** Controller to drive; falls back to `<CanvasProvider>`'s controller. */
  controller?: CanvasController;
  /** Registry for artifact-backed surfaces; defaults to the process-wide one. */
  registry?: SurfaceRegistry;
  /** Override the HTML surface harness URL (else `pd-preview://`). */
  harnessUrl?: string;
  handlers?: CanvasTabsHandlers;
  /**
   * A kind was chosen from the `+` menu (Files / Browser / Terminal). When
   * omitted, the canvas opens a fresh tab of that kind itself.
   */
  onNewTab?: (kind: NewTabKind) => void;
  /** Pop the active tab out to a standalone window. When set, a pop-out control
   * appears in the tab bar for artifact-backed tabs (the app opens the window). */
  onPopout?: (tab: CanvasTab) => void;
  /**
   * Toggle THIS canvas panel (collapse/close). The single panel-toggle control
   * on the right of the tab bar emits this; the app owns the slide-in/out. When
   * omitted, the panel collapses in place to an internal restore rail.
   */
  onCollapse?: () => void;
  /**
   * Whether the canvas panel is OPEN, which drives the panel-toggle glyph: open
   * → an X (close), closed → the panel icon (round-8 #16). The app owns the open
   * state + the toggle's placement; when omitted it's inferred from the internal
   * collapsed state (the expanded tab bar always shows the X).
   */
  panelOpen?: boolean;
  /**
   * Copy handler for the tab-bar Copy control (and per-surface copy). Receives
   * the active surface's content — artifact source (code/text/markdown/svg) or,
   * for media/browser tabs, the src/URL. Defaults to `navigator.clipboard`.
   */
  onCopy?: (text: string) => void;
  onExport?: (content: ArtifactContent) => void;
  /** Fully override the active surface body (else the built-in per-kind renderer). */
  renderSurface?: (tab: CanvasTab) => ReactNode;
  /**
   * The `+` new-tab menu opened/closed. The app uses this to get a native
   * browser WebContentsView out of the way while the menu is up — the overlay
   * paints ABOVE the DOM, so without this the menu is occluded on a browser tab
   * (round-10 #2). Fired with `true` on open, `false` on close.
   */
  onMenuOpenChange?: (open: boolean) => void;
  className?: string;
}

/**
 * CanvasTabs — the TABBED multi-surface container (Aside img7). A tab bar of
 * per-kind type icons + labels + close, with `+` (new tab) / copy / pop-out /
 * panel-toggle controls, over the ACTIVE tab's surface. Only the active surface
 * is mounted; live tabs report `onSurfaceMount(null)` when switched away so the
 * app hides that tab's native view (destroy it when its id leaves
 * `controller.getState().tabs`).
 */
export function CanvasTabs({
  controller,
  registry,
  harnessUrl,
  handlers,
  onNewTab,
  onPopout,
  onCollapse,
  panelOpen,
  onCopy,
  onExport,
  renderSurface,
  onMenuOpenChange,
  className,
}: CanvasTabsProps) {
  const canvas = useCanvasTabs(controller);
  // Per-tab media reload counter: the media operation bar's Refresh bumps it so
  // the surface re-keys and re-fetches the same src (kept here so the bar and the
  // surface — rendered in separate slots — stay in sync).
  const [mediaNonce, setMediaNonce] = useState<Record<string, number>>({});
  const bumpMediaNonce = (id: string): void =>
    setMediaNonce((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  // Per-tab raw↔rendered view (round-8 #13). Seeded from `tab.rawRendered` /
  // the per-type default; the operation-bar toggle overrides it here (and the
  // app may persist via the onFileViewModeChange handler).
  const [viewModes, setViewModes] = useState<Record<string, FileViewMode>>({});
  if (!registry) ensureDefaultSurfaces();
  const activeRegistry = registry ?? defaultSurfaceRegistry;
  const config: CanvasConfig = { harnessUrl: harnessUrl ?? defaultCanvasConfig.harnessUrl };

  const newTab = (kind: NewTabKind): void => {
    if (onNewTab) onNewTab(kind);
    else canvas.openTab({ kind, title: CANVAS_TAB_KINDS[kind].label });
  };
  const viewModeFor = (tab: CanvasTab): FileViewMode =>
    viewModes[tab.id] ?? tab.rawRendered ?? viewModeDefault(tab);
  // The single open/close affordance for the canvas panel. When the app wires
  // `onCollapse` it owns the slide; standalone, we collapse to the restore rail.
  const togglePanel = (): void => {
    if (onCollapse) onCollapse();
    else canvas.setCollapsed(true);
  };
  const copyText = activeCopyText(canvas.activeTab);
  const activeTab = canvas.activeTab;
  // The expanded tab bar is only rendered while the panel is open, so the toggle
  // shows the X (close) by default; the app can override placement via panelOpen.
  const panelIsOpen = panelOpen ?? !canvas.collapsed;

  // ── Tab-strip overflow (round-blindtest #8) ────────────────────────────────
  // With many tabs only a few fit; the ACTIVE tab could scroll off with no hint.
  // The strip is horizontally scrollable (overflow-x:auto); here we (a) ALWAYS
  // scroll the active tab back into view when it changes, so its surface is never
  // hidden, and (b) drive the edge-fade overlays (via this `overflow` state and
  // the `data-overflow-start/-end` hooks) as a "there's more" affordance in
  // place of a scrollbar. NB: the fade lives on sibling overlays, NOT a
  // mask on the scroller — a mask there trapped the fixed `+` popmenu (#8).
  const activeTabId = canvas.activeTabId;
  const tabCount = canvas.tabs.length;
  const tablistRef = useRef<HTMLDivElement | null>(null);
  const activeSlotRef = useRef<HTMLDivElement | null>(null);
  const resizeObsRef = useRef<ResizeObserver | null>(null);
  const [overflow, setOverflow] = useState<{ start: boolean; end: boolean }>({
    start: false,
    end: false,
  });

  const measureOverflow = useCallback((): void => {
    const list = tablistRef.current;
    if (!list) return;
    const max = list.scrollWidth - list.clientWidth;
    const x = list.scrollLeft;
    setOverflow({ start: x > 1, end: x < max - 1 });
  }, []);

  // Callback ref so the ResizeObserver (re)binds exactly when the strip mounts
  // — the strip only exists in the expanded branch, so a plain effect keyed on a
  // stable dep would miss the collapsed→expanded remount.
  const setTablistRef = useCallback(
    (node: HTMLDivElement | null): void => {
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
      tablistRef.current = node;
      if (node && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => measureOverflow());
        ro.observe(node);
        resizeObsRef.current = ro;
      }
      measureOverflow();
    },
    [measureOverflow],
  );

  useEffect(() => () => resizeObsRef.current?.disconnect(), []);

  // Keep the active tab visible whenever it (or the tab set) changes. Manual
  // scrollLeft nudge via bounding rects (offsetParent-agnostic) so it never
  // scrolls an ancestor the way scrollIntoView can.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll on active/count change.
  useEffect(() => {
    const list = tablistRef.current;
    const slot = activeSlotRef.current;
    if (list && slot) {
      const listRect = list.getBoundingClientRect();
      const slotRect = slot.getBoundingClientRect();
      if (slotRect.left < listRect.left) {
        list.scrollLeft -= listRect.left - slotRect.left + 12;
      } else if (slotRect.right > listRect.right) {
        list.scrollLeft += slotRect.right - listRect.right + 12;
      }
    }
    measureOverflow();
  }, [activeTabId, tabCount, measureOverflow]);

  if (canvas.collapsed) {
    return (
      <div
        className={['pd-canvas-tabs', 'pd-canvas-tabs--collapsed', className]
          .filter(Boolean)
          .join(' ')}
      >
        <IconButton
          size="sm"
          aria-label="Open canvas panel"
          onClick={() => canvas.setCollapsed(false)}
        >
          <IconPanelRight size={16} />
        </IconButton>
      </div>
    );
  }

  const rootClass = ['pd-canvas-tabs', className].filter(Boolean).join(' ');
  return (
    <CanvasConfigContext.Provider value={config}>
      <div className={rootClass} data-fullscreen={canvas.fullscreen || undefined}>
        <div className="pd-canvas-tabbar">
          {/* Non-scrolling wrapper: hosts the edge-fade overlays as SIBLINGS of
              the scroller. The fade must not live on the scroller itself (a
              mask there trapped the fixed `+` popmenu behind the panel — #8). */}
          <div className="pd-canvas-tablist-viewport">
            <div
              ref={setTablistRef}
              className="pd-canvas-tablist"
              role="tablist"
              onScroll={measureOverflow}
              data-overflow-start={overflow.start || undefined}
              data-overflow-end={overflow.end || undefined}
            >
              {canvas.tabs.map((tab) => {
                const meta = CANVAS_TAB_KINDS[tab.kind];
                const Icon = meta.icon;
                const active = tab.id === canvas.activeTabId;
                return (
                  <div
                    key={tab.id}
                    ref={active ? activeSlotRef : undefined}
                    className="pd-canvas-tab-slot"
                  >
                    <div
                      className="pd-canvas-tab"
                      data-active={active || undefined}
                      data-kind={tab.kind}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className="pd-canvas-tab-main"
                        onClick={() => canvas.focusTab(tab.id)}
                      >
                        <span className="pd-canvas-tab-icon">{tab.icon ?? <Icon size={14} />}</span>
                        <span className="pd-canvas-tab-label">{tab.title || meta.label}</span>
                      </button>
                      <button
                        type="button"
                        className="pd-canvas-tab-close"
                        aria-label={`Close ${tab.title || meta.label}`}
                        onClick={() => canvas.closeTab(tab.id)}
                      >
                        <IconClose size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {overflow.start ? (
              <span className="pd-canvas-tabfade pd-canvas-tabfade--start" aria-hidden="true" />
            ) : null}
            {overflow.end ? (
              <span className="pd-canvas-tabfade pd-canvas-tabfade--end" aria-hidden="true" />
            ) : null}
          </div>
          {/* The new-tab `+` is the RIGHTMOST element of the tab strip — after
              ALL tabs, always visible (Safari-style), not adjacent to the active
              tab. Only shown once tabs exist; an empty canvas presents the
              new-tab actions in its home state instead. */}
          {canvas.tabs.length > 0 ? (
            <NewTabButton onPick={newTab} onOpenChange={onMenuOpenChange} />
          ) : null}
          <div className="pd-canvas-tabbar-controls">
            {copyText ? <CopyControl text={copyText} onCopy={onCopy} /> : null}
            {onPopout && canvas.activeTab?.artifact ? (
              <IconButton
                size="sm"
                aria-label="Pop out to a window"
                onClick={() => {
                  const tab = canvas.activeTab;
                  if (tab) onPopout(tab);
                }}
              >
                <IconPopout size={16} />
              </IconButton>
            ) : null}
            <IconButton
              size="sm"
              aria-label={panelIsOpen ? 'Close canvas panel' : 'Open canvas panel'}
              onClick={togglePanel}
            >
              {panelIsOpen ? <IconClose size={16} /> : <IconPanelRight size={16} />}
            </IconButton>
          </div>
        </div>

        {activeTab ? (
          <CanvasOperationBar
            tab={activeTab}
            onBrowserBack={() => handlers?.onBrowserBack?.(activeTab.id)}
            onBrowserForward={() => handlers?.onBrowserForward?.(activeTab.id)}
            onBrowserReload={() => handlers?.onBrowserReload?.(activeTab.id)}
            onBrowserNavigate={(url) => handlers?.onBrowserNavigate?.(activeTab.id, url)}
            onBrowserOpenExternal={() => handlers?.onBrowserOpenExternal?.(activeTab.id)}
            onBrowserMenu={() => handlers?.onBrowserMenu?.(activeTab.id)}
            onOpen={() => handlers?.onOpen?.(activeTab.id)}
            onOpenWith={(appId) => handlers?.onOpenWith?.(activeTab.id, appId)}
            onReveal={() => handlers?.onReveal?.(activeTab.id)}
            onFileTreeSelect={(node) => handlers?.onFileTreeSelect?.(activeTab.id, node)}
            fileViewMode={hasViewToggle(activeTab) ? viewModeFor(activeTab) : undefined}
            onFileViewModeChange={(nextMode) => {
              const id = activeTab.id;
              setViewModes((prev) => ({ ...prev, [id]: nextMode }));
              handlers?.onFileViewModeChange?.(id, nextMode);
            }}
            onMediaDownload={(format) => handlers?.onMediaDownload?.(activeTab.id, format)}
            onMediaRefresh={() => {
              bumpMediaNonce(activeTab.id);
              handlers?.onMediaRefresh?.(activeTab.id);
            }}
            onMediaExpand={() => handlers?.onMediaExpand?.(activeTab.id)}
            onClose={() => canvas.closeTab(activeTab.id)}
          />
        ) : null}

        <div className="pd-canvas-tabpanel" role="tabpanel">
          {activeTab ? (
            renderSurface ? (
              // Key by tab id so switching tabs remounts the surface (and its
              // content slot), re-attaching the active tab's native view — without
              // the key React reuses one instance and a prior terminal/browser
              // view stays stuck in the slot.
              <Fragment key={activeTab.id}>{renderSurface(activeTab)}</Fragment>
            ) : (
              <DefaultSurface
                key={activeTab.id}
                tab={activeTab}
                registry={activeRegistry}
                handlers={handlers}
                mediaNonce={mediaNonce[activeTab.id] ?? 0}
                viewMode={hasViewToggle(activeTab) ? viewModeFor(activeTab) : undefined}
                onCopy={onCopy}
                onExport={onExport}
              />
            )
          ) : (
            // Empty canvas (no tabs): present the SAME 4 new-tab actions as the
            // `+` menu directly, up-front, as a centered clickable list (Codex
            // reference) — each opens that surface, no `+` click required. The
            // `+` menu itself is kept for when tabs already exist (in the tab
            // strip). Both map over the shared NEW_TAB_ITEMS so they never drift.
            <div className="pd-canvas-empty pd-canvas-empty--home">
              <span className="pd-canvas-empty-icon" aria-hidden="true">
                <IconPanelRight size={40} />
              </span>
              <p className="pd-canvas-empty-title">Nothing on the canvas yet</p>
              <p className="pd-canvas-empty-sub">
                Open a file tree, a browser, a terminal, or your subagents.
              </p>
              <div className="pd-canvas-empty-actions">
                {NEW_TAB_ITEMS.map((item) => (
                  <NewTabActionRow
                    key={item.kind}
                    item={item}
                    className="pd-canvas-empty-action"
                    onPick={newTab}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </CanvasConfigContext.Provider>
  );
}

/**
 * The tab-strip `+` control — a menu button (round-8 #10) whose popover opens a
 * new Files / Browser / Terminal tab. The trigger keeps the `.pd-canvas-newtab`
 * hook + "New tab" label so it stays discoverable; picking a row calls `onPick`.
 */
function NewTabButton({
  onPick,
  onOpenChange,
}: {
  onPick: (kind: NewTabKind) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  // The `+` lives inside the horizontally-scrolling tab strip (overflow clips
  // both axes), so an absolute dropdown would be cut off at the 40px strip. Pin
  // the menu with position:fixed, measured from the anchor, so it escapes the
  // clip while staying inline (no portal — keeps it self-contained + testable).
  // Clamp the left edge to the viewport so the full menu is always visible.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // Notify the app so it can lower any native browser overlay while the menu is
  // up (round-10 #2); that view otherwise paints over this DOM dropdown.
  const setMenuOpen = (next: boolean): void => {
    setOpen(next);
    onOpenChange?.(next);
  };
  useOutsideClose(ref, open, () => setMenuOpen(false));
  const toggle = (): void => {
    if (open) {
      setMenuOpen(false);
      return;
    }
    const rect = ref.current?.getBoundingClientRect();
    if (rect) {
      const MENU_WIDTH = 200;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8));
      setPos({ top: rect.bottom + 4, left });
    }
    setMenuOpen(true);
  };
  return (
    <div ref={ref} className="pd-canvas-menu-anchor">
      <IconButton
        size="sm"
        className="pd-canvas-newtab"
        aria-label="New tab"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <IconPlus size={16} />
      </IconButton>
      {open ? (
        <div
          className="pd-menu pd-canvas-popmenu pd-canvas-popmenu--fixed"
          role="menu"
          style={pos ? { top: pos.top, left: pos.left } : undefined}
        >
          {NEW_TAB_ITEMS.map((item) => (
            <NewTabActionRow
              key={item.kind}
              item={item}
              role="menuitem"
              className="pd-menu-item"
              onPick={(kind) => {
                setMenuOpen(false);
                onPick(kind);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface DefaultSurfaceProps {
  tab: CanvasTab;
  registry: SurfaceRegistry;
  handlers?: CanvasTabsHandlers;
  /** Media reload counter for the active tab (bumped by the operation bar). */
  mediaNonce?: number;
  /** Raw↔rendered view for a toggle-bearing tab (from the operation-bar toggle). */
  viewMode?: FileViewMode;
  onCopy?: (text: string) => void;
  onExport?: (content: ArtifactContent) => void;
}

/**
 * The built-in per-kind body renderer wired to the app handler contract. The
 * browser nav chrome and the media header controls now live in the per-tab
 * {@link CanvasOperationBar}; the surfaces here render CONTENT only.
 */
function DefaultSurface({
  tab,
  registry,
  handlers,
  mediaNonce = 0,
  viewMode,
  onCopy,
  onExport,
}: DefaultSurfaceProps) {
  const id = tab.id;
  switch (tab.kind) {
    case 'browser':
      return (
        <BrowserSurface
          url={tab.url}
          driving={tab.driving}
          onMount={(el) => handlers?.onSurfaceMount?.(id, 'browser', el)}
          onRectChange={(rect) => handlers?.onSurfaceRectChange?.(id, 'browser', rect)}
        />
      );
    case 'terminal':
      return (
        <TerminalSurface
          title={tab.title}
          onMount={(el) => handlers?.onSurfaceMount?.(id, 'terminal', el)}
          onRectChange={(rect) => handlers?.onSurfaceRectChange?.(id, 'terminal', rect)}
        />
      );
    case 'subagent':
      return (
        <SubagentSurface
          subagents={tab.subagents ?? []}
          onSelect={(subagentId) => handlers?.onSubagentSelect?.(id, subagentId)}
        />
      );
    case 'filetree':
      // The full-canvas project file tree (round-10 #4). The app feeds `fileTree`
      // (rooted at the active project/cwd) + `fileTreeRootLabel`; picking a FILE
      // routes through onFileTreeSelect (the app opens it in its own file tab).
      return (
        <div className="pd-canvas-filetree">
          <FileTree
            tree={tab.fileTree ?? []}
            rootLabel={tab.fileTreeRootLabel}
            onSelect={(node) => handlers?.onFileTreeSelect?.(id, node)}
          />
        </div>
      );
    case 'image':
    case 'pdf':
      return (
        <MediaPreviewSurface
          src={tab.mediaSrc ?? tab.artifact?.content.text}
          type={tab.mediaType ?? (tab.kind === 'pdf' ? 'PDF' : 'PNG')}
          index={tab.mediaIndex}
          status={tab.mediaStatus}
          reloadNonce={mediaNonce}
          onRefresh={() => handlers?.onMediaRefresh?.(id)}
        />
      );
    case 'file': {
      // A file tab can open EMPTY and fill incrementally as the model writes it,
      // so fall back to empty content instead of a "no surface" placeholder.
      const content = tab.artifact?.content ?? { kind: 'text', text: '' };
      const filename = tab.artifact?.filename ?? basename(tab.filePath);
      // A real on-disk file (has a path), not mid-write, is editable when the app
      // wired a save handler — the raw/code editor persists ⌘S back to disk.
      const editable =
        tab.filePath !== undefined && !tab.streaming && handlers?.onFileSave !== undefined;
      return (
        <FileSurface
          content={content}
          filename={filename}
          streaming={tab.streaming}
          mode={viewMode}
          // The operation-bar breadcrumb already names the file — hide the
          // surface's own header so the filename isn't shown twice (round-8 #12).
          showFilename={false}
          onCopy={onCopy}
          editable={editable}
          onSave={editable ? (text) => handlers?.onFileSave?.(id, text) : undefined}
        />
      );
    }
    default: {
      // Artifact-backed surfaces (html | svg | markdown | code) via the registry.
      if (!tab.artifact) return <SurfaceMissing kind={tab.kind} />;
      // RAW view → the shared syntax-highlighted source editor (read-only; these
      // artifact tabs have no file path to persist to). Same path as <Canvas>.
      if (viewMode === 'raw') {
        return (
          <div className="pd-canvas-raw pd-scroll">
            <CodeSurface
              content={rawSourceContent(tab.artifact.content)}
              streaming={tab.streaming ?? false}
              onCopy={onCopy}
            />
          </div>
        );
      }
      const resolved = registry.resolve(tab.artifact);
      if (!resolved) return <SurfaceMissing kind={tab.kind} />;
      const Surface = resolved.component;
      return (
        <Surface
          content={tab.artifact.content}
          streaming={tab.streaming ?? false}
          onCopy={onCopy}
          onExport={onExport}
        />
      );
    }
  }
}

function SurfaceMissing({ kind }: { kind: string }) {
  return <div className="pd-canvas-empty">No surface for “{kind}”.</div>;
}

/** Last path segment of a file path (the display filename), or undefined. */
function basename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

/**
 * The copyable text for the active tab: artifact source (code/text/markdown/svg)
 * for artifact-backed surfaces and the media `src`/URL for image/pdf. Live
 * browser/terminal/subagent/filetree tabs have nothing to copy → '' (the tab bar
 * hides the Copy control) — a browser tab's URL lives in its address bar, not a
 * Copy button (round-10 #3).
 */
function activeCopyText(tab: CanvasTab | null): string {
  if (!tab) return '';
  // Copy is for code/text/media surfaces — NOT a live browser tab (round-10 #3):
  // "copy the URL" doesn't belong on the browser chrome, so the tab-bar Copy
  // control is hidden there.
  if (tab.kind === 'browser') return '';
  if (tab.kind === 'image' || tab.kind === 'pdf') {
    return tab.mediaSrc ?? tab.artifact?.content.text ?? '';
  }
  return tab.artifact?.content.text ?? '';
}

/**
 * Self-contained Copy control for the tab bar: copies the active surface's
 * content, then swaps to a check for ~2s before reverting. Uses the `onCopy`
 * prop when supplied (the app's clipboard), else `navigator.clipboard`. Inlined
 * here so the canvas copy feedback doesn't depend on a shared ui CopyButton.
 */
function CopyControl({ text, onCopy }: { text: string; onCopy?: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const handleCopy = (): void => {
    if (onCopy) onCopy(text);
    else void navigator.clipboard?.writeText(text);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };
  return (
    <IconButton size="sm" aria-label={copied ? 'Copied' : 'Copy'} onClick={handleCopy}>
      {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
    </IconButton>
  );
}
