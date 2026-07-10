import {
  Button,
  IconButton,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconExternal,
  IconMore,
  IconRefresh,
} from '@pi-desktop/ui';
import {
  type FormEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  IconArrowLeft,
  IconArrowRight,
  IconDownload,
  IconExpand,
  IconFolders,
} from '../tab-icons.tsx';
import { FileTree } from './file-tree.tsx';
import type { CanvasTab, FileTreeNode, OpenWithAppId } from './tab-model.ts';

/** The apps offered in the file surface's "Open ▾" dropdown, in display order. */
const OPEN_WITH_APPS: ReadonlyArray<{ id: OpenWithAppId; label: string }> = [
  { id: 'vscode-insiders', label: 'VS Code Insiders' },
  { id: 'default', label: 'Default app' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'xcode', label: 'Xcode' },
];

/**
 * Breadcrumb segments for a file tab: explicit `breadcrumb`, else the path split
 * on separators, else the artifact filename, else the tab title. Exported for
 * unit tests.
 */
export function deriveBreadcrumb(tab: CanvasTab): string[] {
  if (tab.breadcrumb?.length) return tab.breadcrumb;
  const path = tab.filePath ?? tab.artifact?.filename;
  if (path) return path.split(/[/\\]/).filter(Boolean);
  return tab.title ? [tab.title] : [];
}

/** Display name for the media label ("<name> · <TYPE>"). */
function mediaName(tab: CanvasTab): string {
  const path = tab.filePath ?? tab.artifact?.filename ?? tab.title;
  return path ? (path.split(/[/\\]/).filter(Boolean).pop() ?? path) : 'Preview';
}

export interface CanvasOperationBarProps {
  /** The ACTIVE tab whose operations this bar renders. */
  tab: CanvasTab;
  // browser
  onBrowserBack?: () => void;
  onBrowserForward?: () => void;
  onBrowserReload?: () => void;
  onBrowserNavigate?: (url: string) => void;
  onBrowserOpenExternal?: () => void;
  onBrowserMenu?: () => void;
  // file
  onOpenWith?: (appId: OpenWithAppId) => void;
  onReveal?: () => void;
  onFileTreeSelect?: (node: FileTreeNode) => void;
  // media (image | pdf)
  onMediaDownload?: (format: string) => void;
  onMediaRefresh?: () => void;
  onMediaExpand?: () => void;
  // shared
  onClose?: () => void;
  className?: string;
}

/**
 * CanvasOperationBar — the SECOND bar under the tab strip, showing the active
 * tab's operations by kind: a file breadcrumb + file-tree + "Open ▾"; browser
 * back/fwd/refresh/URL/external/⋮; media name + download/refresh/expand/close.
 * Terminal (and the minimal code/markdown/svg/html kinds, whose copy lives in
 * the tab bar) render NOTHING — the bar collapses so those surfaces get the full
 * height. Every control is presentational and emits its callback for the app.
 */
export function CanvasOperationBar(props: CanvasOperationBarProps): ReactElement | null {
  const { tab, className } = props;
  const inner = renderOps(props);
  if (!inner) return null;
  const rootClass = ['pd-canvas-opbar', className].filter(Boolean).join(' ');
  return (
    <div className={rootClass} data-kind={tab.kind}>
      {inner}
    </div>
  );
}

/** The per-kind operation set, or null for kinds with no bar. */
function renderOps(props: CanvasOperationBarProps): ReactNode {
  const { tab } = props;
  switch (tab.kind) {
    case 'file':
      return <FileOps {...props} />;
    case 'browser':
      return <BrowserOps {...props} />;
    case 'image':
    case 'pdf':
      return <MediaOps {...props} />;
    default:
      // terminal / subagent / code / markdown / svg / html — no operation bar.
      return null;
  }
}

/* ── File ───────────────────────────────────────────────────────────────── */

function FileOps({ tab, onOpenWith, onReveal, onFileTreeSelect }: CanvasOperationBarProps) {
  const [treeOpen, setTreeOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLDivElement>(null);

  useOutsideClose(treeRef, treeOpen, () => setTreeOpen(false));
  useOutsideClose(openRef, openMenu, () => setOpenMenu(false));

  const crumbs = deriveBreadcrumb(tab);
  return (
    <>
      <nav className="pd-canvas-crumbs" aria-label="File path">
        {crumbs.length > 0 ? (
          crumbs.map((segment, index) => {
            const last = index === crumbs.length - 1;
            // Cumulative prefix is a stable, unique key even with repeated names.
            const key = crumbs.slice(0, index + 1).join('/');
            return (
              <span key={key} className="pd-canvas-crumb" data-file={last || undefined}>
                {index > 0 ? (
                  <span className="pd-canvas-crumb-sep" aria-hidden="true">
                    <IconChevronRight size={12} />
                  </span>
                ) : null}
                <span className="pd-canvas-crumb-label">{segment}</span>
              </span>
            );
          })
        ) : (
          <span className="pd-canvas-crumb" data-file>
            <span className="pd-canvas-crumb-label">{tab.title || 'File'}</span>
          </span>
        )}
      </nav>
      <span className="pd-canvas-opbar-spacer" />
      <div ref={treeRef} className="pd-canvas-opbar-pop">
        <IconButton
          size="sm"
          aria-label="Toggle file tree"
          aria-expanded={treeOpen}
          onClick={() => setTreeOpen((open) => !open)}
        >
          <IconFolders size={16} />
        </IconButton>
        {treeOpen ? (
          <div className="pd-canvas-tree-panel" role="dialog" aria-label="Files">
            <FileTree
              tree={tab.fileTree ?? []}
              activePath={tab.filePath}
              onSelect={(node) => {
                onFileTreeSelect?.(node);
                setTreeOpen(false);
              }}
            />
          </div>
        ) : null}
      </div>
      <div ref={openRef} className="pd-canvas-opbar-pop">
        <Button
          size="sm"
          variant="secondary"
          aria-label="Open with"
          aria-expanded={openMenu}
          onClick={() => setOpenMenu((open) => !open)}
        >
          Open
          <IconChevronDown size={14} />
        </Button>
        {openMenu ? (
          <div className="pd-canvas-menu" role="menu">
            {OPEN_WITH_APPS.map((app) => (
              <button
                key={app.id}
                type="button"
                role="menuitem"
                className="pd-canvas-menu-item"
                onClick={() => {
                  setOpenMenu(false);
                  onOpenWith?.(app.id);
                }}
              >
                {app.label}
              </button>
            ))}
            <div className="pd-canvas-menu-sep" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              className="pd-canvas-menu-item"
              onClick={() => {
                setOpenMenu(false);
                onReveal?.();
              }}
            >
              Open in folder
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}

/* ── Browser ────────────────────────────────────────────────────────────── */

function BrowserOps({
  tab,
  onBrowserBack,
  onBrowserForward,
  onBrowserReload,
  onBrowserNavigate,
  onBrowserOpenExternal,
  onBrowserMenu,
}: CanvasOperationBarProps) {
  const [draft, setDraft] = useState(tab.url ?? '');
  // Reflect app-driven navigation (browser-use) back into the URL bar.
  useEffect(() => {
    setDraft(tab.url ?? '');
  }, [tab.url]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const value = draft.trim();
    if (value) onBrowserNavigate?.(value);
  };
  return (
    <>
      <div className="pd-browser-nav">
        <IconButton
          size="sm"
          aria-label="Back"
          disabled={!tab.canGoBack}
          onClick={() => onBrowserBack?.()}
        >
          <IconArrowLeft size={16} />
        </IconButton>
        <IconButton
          size="sm"
          aria-label="Forward"
          disabled={!tab.canGoForward}
          onClick={() => onBrowserForward?.()}
        >
          <IconArrowRight size={16} />
        </IconButton>
        <IconButton size="sm" aria-label="Refresh" onClick={() => onBrowserReload?.()}>
          <IconRefresh size={16} />
        </IconButton>
      </div>
      <form className="pd-browser-urlform" onSubmit={submit}>
        <input
          className="pd-browser-url"
          type="text"
          inputMode="url"
          placeholder="Enter a URL"
          aria-label="Address bar"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        {tab.loading ? <span className="pd-browser-loading" aria-hidden="true" /> : null}
      </form>
      <IconButton
        size="sm"
        aria-label="Open in external browser"
        onClick={() => onBrowserOpenExternal?.()}
      >
        <IconExternal size={16} />
      </IconButton>
      <IconButton size="sm" aria-label="Browser menu" onClick={() => onBrowserMenu?.()}>
        <IconMore size={16} />
      </IconButton>
    </>
  );
}

/* ── Media (image | pdf) ────────────────────────────────────────────────── */

function MediaOps({
  tab,
  onMediaDownload,
  onMediaRefresh,
  onMediaExpand,
  onClose,
}: CanvasOperationBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useOutsideClose(menuRef, menuOpen, () => setMenuOpen(false));

  const type = (tab.mediaType ?? (tab.kind === 'pdf' ? 'PDF' : 'PNG')).toUpperCase();
  const formats = tab.downloadFormats ?? [type];
  const primary = formats[0] ?? type;
  return (
    <>
      <span className="pd-media-title">
        {mediaName(tab)} · <span className="pd-media-type">{type}</span>
      </span>
      <span className="pd-canvas-opbar-spacer" />
      <div ref={menuRef} className="pd-media-download">
        <Button size="sm" variant="secondary" onClick={() => onMediaDownload?.(primary)}>
          <IconDownload size={14} />
          Download as {primary.toUpperCase()}
        </Button>
        {formats.length > 1 ? (
          <>
            <IconButton
              size="sm"
              variant="secondary"
              aria-label="Download options"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <IconChevronDown size={14} />
            </IconButton>
            {menuOpen ? (
              <div className="pd-canvas-menu" role="menu">
                {formats.map((format) => (
                  <button
                    key={format}
                    type="button"
                    role="menuitem"
                    className="pd-canvas-menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onMediaDownload?.(format);
                    }}
                  >
                    {format.toUpperCase()}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      <IconButton size="sm" aria-label="Refresh preview" onClick={() => onMediaRefresh?.()}>
        <IconRefresh size={16} />
      </IconButton>
      <IconButton size="sm" aria-label="Expand preview" onClick={() => onMediaExpand?.()}>
        <IconExpand size={16} />
      </IconButton>
      <IconButton size="sm" aria-label="Close preview" onClick={() => onClose?.()}>
        <IconClose size={16} />
      </IconButton>
    </>
  );
}

/* ── shared ─────────────────────────────────────────────────────────────── */

/** Close a popover on any outside pointer-down while it's open. */
function useOutsideClose(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, close, ref]);
}
