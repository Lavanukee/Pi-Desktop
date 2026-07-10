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
