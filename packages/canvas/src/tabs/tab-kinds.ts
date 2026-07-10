import { IconFile, IconGlobe, IconImage, type IconProps, IconTerminal } from '@pi-desktop/ui';
import type { ComponentType } from 'react';
import { IconCode, IconFolder, IconMarkup, IconPdf, IconSubagent } from '../tab-icons.tsx';
import type { CanvasTabKind } from './tab-model.ts';

/** Per-kind chrome + routing metadata — the single source the tab bar reads. */
export interface CanvasTabKindMeta {
  kind: CanvasTabKind;
  /** Default tab label when a spec omits `title`. */
  label: string;
  /** Default type icon shown in the tab (overridable per-tab via `tab.icon`). */
  icon: ComponentType<IconProps>;
  /**
   * LIVE surface: driven by app-mounted native content (a WebContentsView, a
   * PTY, live subagent data) rather than an artifact's text. The app must wire
   * these via the CanvasTabs handler contract.
   */
  live: boolean;
  /**
   * Default routing weight. `true` = this kind always opens in the canvas.
   * `false` = inline-eligible in the chat when small (see `shouldGoToCanvas`).
   */
  opensInCanvas: boolean;
}

export const CANVAS_TAB_KINDS: Record<CanvasTabKind, CanvasTabKindMeta> = {
  browser: { kind: 'browser', label: 'New tab', icon: IconGlobe, live: true, opensInCanvas: true },
  file: { kind: 'file', label: 'File', icon: IconFile, live: false, opensInCanvas: true },
  // Full-canvas project file tree (the `+ › Files` surface). App-fed like a live
  // surface (the tree comes from the app), rendered directly (no artifact).
  filetree: { kind: 'filetree', label: 'Files', icon: IconFolder, live: true, opensInCanvas: true },
  terminal: {
    kind: 'terminal',
    label: 'Terminal',
    icon: IconTerminal,
    live: true,
    opensInCanvas: true,
  },
  html: { kind: 'html', label: 'Preview', icon: IconMarkup, live: false, opensInCanvas: false },
  svg: { kind: 'svg', label: 'SVG', icon: IconMarkup, live: false, opensInCanvas: false },
  image: { kind: 'image', label: 'Image', icon: IconImage, live: false, opensInCanvas: true },
  pdf: { kind: 'pdf', label: 'PDF', icon: IconPdf, live: false, opensInCanvas: true },
  subagent: {
    kind: 'subagent',
    label: 'Subagents',
    icon: IconSubagent,
    live: true,
    opensInCanvas: true,
  },
  markdown: {
    kind: 'markdown',
    label: 'Document',
    icon: IconFile,
    live: false,
    opensInCanvas: true,
  },
  code: { kind: 'code', label: 'Code', icon: IconCode, live: false, opensInCanvas: true },
};

/** Whether a kind opens in the canvas by default (vs. inline-eligible in chat). */
export function kindOpensInCanvas(kind: CanvasTabKind): boolean {
  return CANVAS_TAB_KINDS[kind].opensInCanvas;
}
