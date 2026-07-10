import type { ReactNode } from 'react';
import type { Artifact } from '../model.ts';

/**
 * The kinds a canvas tab can host. Each maps to a surface component (browser |
 * terminal | subagent are LIVE surfaces the app wires to native content; the
 * rest render from an {@link Artifact}). The union is closed on purpose here —
 * the tab bar renders a per-kind type icon — but a new kind is a one-line add
 * across this union + `CANVAS_TAB_KINDS`.
 */
export type CanvasTabKind =
  | 'browser'
  | 'file'
  | 'filetree'
  | 'terminal'
  | 'html'
  | 'svg'
  | 'image'
  | 'pdf'
  | 'subagent'
  | 'markdown'
  | 'code';

/** The media-preview surface's load state (loading → loaded | error). */
export type MediaPreviewStatus = 'loading' | 'loaded' | 'error';

/**
 * One node in a {@link FileTree}. A `dir` node carries `children`; a `file` node
 * is a leaf. `path` is the full path used for breadcrumb/open/reveal targeting;
 * `name` is the display label. Pure data — no UI coupling.
 */
export interface FileTreeNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: FileTreeNode[];
}

/**
 * Identifier of an app in the file "Open with" list — a system app id / bundle
 * id the app resolves. Free-form: the desktop app supplies the real app list.
 * `Open in folder` is emitted separately via `onReveal` (it reveals, not opens).
 */
export type OpenWithAppId = string;

/**
 * One app in the file "Open" split button. The desktop app fetches the system
 * icon and passes it as a `data:` URL; the canvas renders whatever is given and
 * falls back to a generic app glyph when `iconDataUrl` is absent.
 */
export interface OpenWithApp {
  id: OpenWithAppId;
  name: string;
  /** `data:` URL of the app's system icon (app-supplied; optional). */
  iconDataUrl?: string;
}

/** A file tab's raw↔rendered view preference (md defaults to rendered, code to raw). */
export type FileViewMode = 'raw' | 'rendered';

/** One subagent row in the subagent surface (pure data — no UI coupling). */
export interface SubagentItem {
  id: string;
  name: string;
  /** The subagent's current step ("Reading files…"); shimmered while running. */
  step?: string;
  status?: 'queued' | 'running' | 'done' | 'error';
}

/**
 * A canvas tab. `id` is controller-assigned; `key` is the app-stable upsert key
 * (an artifact id or URL) so re-opening the same artifact focuses its existing
 * tab instead of piling up duplicates. The typed optional fields carry the
 * common live-surface state; `data` is an escape hatch for anything else.
 */
export interface CanvasTab {
  id: string;
  kind: CanvasTabKind;
  title: string;
  /** Stable identity for `upsertTab(key, …)` — open-or-focus by this key. */
  key?: string;
  /** Override the kind's default type icon in the tab bar. */
  icon?: ReactNode;
  /** Artifact-backed surfaces (code | markdown | html | svg | image | pdf | file). */
  artifact?: Artifact;
  /**
   * When true, the file/code surface treats `artifact.content` as LIVE — it
   * reconciles appended text without resetting scroll and auto-scrolls to the
   * newest line as the file is written. Set while a write/edit is in flight.
   */
  streaming?: boolean;

  // file surface state (the per-tab operation bar reads these)
  /** Full path of the open file — drives the breadcrumb + open/reveal targeting. */
  filePath?: string;
  /** Explicit breadcrumb segments; when omitted they derive from `filePath`. */
  breadcrumb?: string[];
  /** Tree shown in the file surface's toggleable file-tree panel. */
  fileTree?: FileTreeNode[];
  /** Top-level label for the file tree (the project / working folder). */
  fileTreeRootLabel?: string;
  /** Default app for the "Open" split button (its icon shows on the Open segment). */
  defaultApp?: OpenWithApp;
  /** Apps in the "Open with" dropdown — the {@link defaultApp} is omitted from it. */
  openApps?: OpenWithApp[];
  /** Persisted raw↔rendered preference for the file view (per-tab). */
  rawRendered?: FileViewMode;

  // browser surface state (app-updated via controller.updateTab)
  url?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  loading?: boolean;
  /** Show the "model is driving" indicator on the browser chrome. */
  driving?: boolean;

  // media surface state (image | pdf)
  mediaSrc?: string;
  mediaType?: string;
  mediaIndex?: number;
  mediaStatus?: MediaPreviewStatus;
  /** Formats offered in the media operation bar's "Download as …" dropdown. */
  downloadFormats?: string[];

  // subagent surface state
  subagents?: SubagentItem[];

  /** Free-form per-surface data the core never reads. */
  data?: Record<string, unknown>;
}

/** What `openTab`/`upsertTab` accept — a tab without its controller-assigned id. */
export type CanvasTabSpec = Omit<CanvasTab, 'id'> & { id?: string };

/** The whole reducer-owned canvas state (pure, serializable, testable). */
export interface CanvasState {
  /** Ordered left→right as shown in the tab bar. */
  tabs: CanvasTab[];
  /** The focused tab, or `null` when there are no tabs. */
  activeTabId: string | null;
  /** Canvas minimized (the app hides the panel; the tab set is preserved). */
  collapsed: boolean;
  /** Canvas expanded to fill the window. */
  fullscreen: boolean;
}

/** A fresh, empty canvas. */
export const emptyCanvasState: CanvasState = {
  tabs: [],
  activeTabId: null,
  collapsed: false,
  fullscreen: false,
};
