import { IconButton, IconCheck, IconClose, IconCopy, IconPlus } from '@pi-desktop/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type CanvasConfig, CanvasConfigContext, defaultCanvasConfig } from '../context.ts';
import type { ArtifactContent } from '../model.ts';
import { defaultSurfaceRegistry, type SurfaceRegistry } from '../registry.ts';
import { BrowserSurface } from '../surfaces/browser-surface.tsx';
import { FileSurface } from '../surfaces/file-surface.tsx';
import { MediaPreviewSurface } from '../surfaces/media-preview-surface.tsx';
import { ensureDefaultSurfaces } from '../surfaces/register-builtins.tsx';
import { SubagentSurface } from '../surfaces/subagent-surface.tsx';
import { TerminalSurface } from '../surfaces/terminal-surface.tsx';
import { IconPanelRight, IconPopout } from '../tab-icons.tsx';
import { CanvasOperationBar } from './canvas-operation-bar.tsx';
import type { CanvasController } from './controller.ts';
import { CANVAS_TAB_KINDS } from './tab-kinds.ts';
import type { CanvasTab, FileTreeNode, OpenWithAppId } from './tab-model.ts';
import { useCanvasTabs } from './use-canvas-tabs.tsx';

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
  /** File operation bar — "Open ▾" dropdown app items (shell out to open-with). */
  onOpenWith?: (tabId: string, appId: OpenWithAppId) => void;
  /** File operation bar — "Open in folder" (reveal the file in the OS shell). */
  onReveal?: (tabId: string) => void;
  /** File operation bar — a file chosen from the toggleable file-tree panel. */
  onFileTreeSelect?: (tabId: string, node: FileTreeNode) => void;
}

export interface CanvasTabsProps {
  /** Controller to drive; falls back to `<CanvasProvider>`'s controller. */
  controller?: CanvasController;
  /** Registry for artifact-backed surfaces; defaults to the process-wide one. */
  registry?: SurfaceRegistry;
  /** Override the HTML surface harness URL (else `pd-preview://`). */
  harnessUrl?: string;
  handlers?: CanvasTabsHandlers;
  /** `+` click; defaults to opening a fresh browser tab. */
  onNewTab?: () => void;
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
   * Copy handler for the tab-bar Copy control (and per-surface copy). Receives
   * the active surface's content — artifact source (code/text/markdown/svg) or,
   * for media/browser tabs, the src/URL. Defaults to `navigator.clipboard`.
   */
  onCopy?: (text: string) => void;
  onExport?: (content: ArtifactContent) => void;
  /** Fully override the active surface body (else the built-in per-kind renderer). */
  renderSurface?: (tab: CanvasTab) => ReactNode;
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
  onCopy,
  onExport,
  renderSurface,
  className,
}: CanvasTabsProps) {
  const canvas = useCanvasTabs(controller);
  // Per-tab media reload counter: the media operation bar's Refresh bumps it so
  // the surface re-keys and re-fetches the same src (kept here so the bar and the
  // surface — rendered in separate slots — stay in sync).
  const [mediaNonce, setMediaNonce] = useState<Record<string, number>>({});
  const bumpMediaNonce = (id: string): void =>
    setMediaNonce((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  if (!registry) ensureDefaultSurfaces();
  const activeRegistry = registry ?? defaultSurfaceRegistry;
  const config: CanvasConfig = { harnessUrl: harnessUrl ?? defaultCanvasConfig.harnessUrl };

  const newTab = (): void => {
    if (onNewTab) onNewTab();
    else canvas.openTab({ kind: 'browser', title: 'New tab' });
  };
  // The single open/close affordance for the canvas panel. When the app wires
  // `onCollapse` it owns the slide; standalone, we collapse to the restore rail.
  const togglePanel = (): void => {
    if (onCollapse) onCollapse();
    else canvas.setCollapsed(true);
  };
  const copyText = activeCopyText(canvas.activeTab);
  const activeTab = canvas.activeTab;

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
          <div className="pd-canvas-tablist" role="tablist">
            {canvas.tabs.map((tab) => {
              const meta = CANVAS_TAB_KINDS[tab.kind];
              const Icon = meta.icon;
              const active = tab.id === canvas.activeTabId;
              return (
                // The new-tab `+` sits immediately AFTER the active tab (not at
                // the far right of the strip).
                <div key={tab.id} className="pd-canvas-tab-slot">
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
                  {active ? (
                    <IconButton
                      size="sm"
                      className="pd-canvas-newtab"
                      aria-label="New tab"
                      onClick={newTab}
                    >
                      <IconPlus size={16} />
                    </IconButton>
                  ) : null}
                </div>
              );
            })}
          </div>
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
            <IconButton size="sm" aria-label="Toggle canvas panel" onClick={togglePanel}>
              <IconPanelRight size={16} />
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
            onOpenWith={(appId) => handlers?.onOpenWith?.(activeTab.id, appId)}
            onReveal={() => handlers?.onReveal?.(activeTab.id)}
            onFileTreeSelect={(node) => handlers?.onFileTreeSelect?.(activeTab.id, node)}
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
              renderSurface(activeTab)
            ) : (
              <DefaultSurface
                tab={activeTab}
                registry={activeRegistry}
                handlers={handlers}
                mediaNonce={mediaNonce[activeTab.id] ?? 0}
                onCopy={onCopy}
                onExport={onExport}
              />
            )
          ) : (
            <div className="pd-canvas-empty">
              <p className="pd-canvas-empty-title">No surfaces open</p>
              <IconButton size="sm" aria-label="New tab" onClick={newTab}>
                <IconPlus size={16} />
              </IconButton>
            </div>
          )}
        </div>
      </div>
    </CanvasConfigContext.Provider>
  );
}

interface DefaultSurfaceProps {
  tab: CanvasTab;
  registry: SurfaceRegistry;
  handlers?: CanvasTabsHandlers;
  /** Media reload counter for the active tab (bumped by the operation bar). */
  mediaNonce?: number;
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
      return (
        <FileSurface
          content={content}
          filename={filename}
          streaming={tab.streaming}
          onCopy={onCopy}
        />
      );
    }
    default: {
      // Artifact-backed surfaces (html | svg | markdown | code) via the registry.
      if (!tab.artifact) return <SurfaceMissing kind={tab.kind} />;
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
 * for artifact-backed surfaces, the media `src`/URL for image/pdf, and the page
 * URL for a browser tab. Live terminal/subagent tabs have nothing to copy → ''
 * (the tab bar hides the Copy control).
 */
function activeCopyText(tab: CanvasTab | null): string {
  if (!tab) return '';
  if (tab.kind === 'browser') return tab.url ?? '';
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
