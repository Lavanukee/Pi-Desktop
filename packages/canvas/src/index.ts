/**
 * @pi-desktop/canvas — the universal canvas surface registry + built-in
 * renderers (code | markdown | html | svg), plus the `pd-preview://` sandboxed
 * HTML harness contract. Electron-free: the harness is a static asset + a
 * postMessage protocol; the app registers the protocol and mounts <Canvas>.
 *
 * Load `@pi-desktop/canvas/styles.css` once at the root (after themes + ui).
 */

export type { CanvasPlacement, CanvasProps } from './canvas.tsx';
// Panel integration
export { Canvas } from './canvas.tsx';
export type { CanvasConfig } from './context.ts';
export { CanvasConfigContext, defaultCanvasConfig } from './context.ts';
export { artifactFilename, artifactMimeType, downloadArtifact } from './export-artifact.ts';
export type { StartHarnessOptions } from './harness/harness-runtime.ts';
export { startHarness } from './harness/harness-runtime.ts';
export type { ApplyHtmlPatchOptions } from './harness/patcher.ts';
export { applyHtmlPatch } from './harness/patcher.ts';
export type {
  AppliedMessage,
  ErrorMessage,
  FrameToHostMessage,
  HostToFrameMessage,
  PatchMessage,
  PingMessage,
  ReadyMessage,
  ResetMessage,
  ResizeMessage,
} from './harness/protocol.ts';
// pd-preview:// harness contract
export {
  isFrameToHostMessage,
  isHostToFrameMessage,
  PD_CANVAS_CHANNEL,
  PD_PREVIEW_HARNESS_HOST,
  PD_PREVIEW_HARNESS_PATH,
  PD_PREVIEW_HARNESS_URL,
  PD_PREVIEW_SCHEME,
} from './harness/protocol.ts';
// Inline vs canvas (THEME 2)
export type { InlineWidgetProps, ShouldGoToCanvasOptions } from './inline-widget.tsx';
export { InlineWidget, shouldGoToCanvas } from './inline-widget.tsx';
// Model
export type { Artifact, ArtifactContent, ArtifactKind, KnownArtifactKind } from './model.ts';
export type { SurfaceDefinition, SurfaceProps } from './registry.ts';
// Registry
export {
  defaultSurfaceRegistry,
  matchKind,
  registerSurface,
  resolveSurface,
  SurfaceRegistry,
} from './registry.ts';
// Sanitization trust boundaries
export { sanitizeHtmlStatic, sanitizeSvg } from './sanitize.ts';
// Surfaces
export type { BrowserSurfaceProps } from './surfaces/browser-surface.tsx';
export { BrowserSurface } from './surfaces/browser-surface.tsx';
export { streamingUpdateSpec } from './surfaces/code-append.ts';
export type { CodeSurfaceProps } from './surfaces/code-surface.tsx';
export { CodeSurface, rawSourceContent } from './surfaces/code-surface.tsx';
// Content-slot / rect contract (native WebContentsView / PTY mounting)
export type { ContentSlotOptions } from './surfaces/content-slot.ts';
export { useContentSlot } from './surfaces/content-slot.ts';
export type { FileSurfaceProps } from './surfaces/file-surface.tsx';
export { defaultFileViewMode, FileSurface } from './surfaces/file-surface.tsx';
export type { FrameGate, HtmlSurfaceProps } from './surfaces/html-surface.tsx';
export { HtmlSurface, HtmlSurfaceController } from './surfaces/html-surface.tsx';
export { languageExtension } from './surfaces/languages.ts';
export { MarkdownSurface } from './surfaces/markdown-surface.tsx';
export type {
  MediaPreviewEvent,
  MediaPreviewStatus,
  MediaPreviewSurfaceProps,
} from './surfaces/media-preview-surface.tsx';
export { MediaPreviewSurface, mediaPreviewTransition } from './surfaces/media-preview-surface.tsx';
export { ensureDefaultSurfaces, registerBuiltinSurfaces } from './surfaces/register-builtins.tsx';
export type { SubagentSurfaceProps } from './surfaces/subagent-surface.tsx';
export { SubagentSurface } from './surfaces/subagent-surface.tsx';
export { SvgSurface } from './surfaces/svg-surface.tsx';
export type { TerminalSurfaceProps } from './surfaces/terminal-surface.tsx';
export { TerminalSurface } from './surfaces/terminal-surface.tsx';
// Canvas-local chrome icons (pdf/subagent/expand/minimize/panel-toggle/download/nav)
export {
  IconAppGeneric,
  IconArrowLeft,
  IconArrowRight,
  IconCode,
  IconDownload,
  IconExpand,
  IconFolder,
  IconFolders,
  IconMarkup,
  IconMinimize,
  IconPanelRight,
  IconPdf,
  IconPopout,
  IconSubagent,
} from './tab-icons.tsx';
// Per-tab operation bar (breadcrumb / file-tree / open-with; browser nav; media)
export type { CanvasOperationBarProps } from './tabs/canvas-operation-bar.tsx';
export {
  CanvasOperationBar,
  deriveBreadcrumb,
  fileViewModeDefault,
  hasViewToggle,
  isMarkdownFile,
  viewModeDefault,
} from './tabs/canvas-operation-bar.tsx';
// Tabbed canvas (THEME 1)
export type { CanvasTabsHandlers, CanvasTabsProps, NewTabKind } from './tabs/canvas-tabs.tsx';
export { CanvasTabs } from './tabs/canvas-tabs.tsx';
export type { CanvasControllerOptions } from './tabs/controller.ts';
export { CanvasController, createCanvasController } from './tabs/controller.ts';
// Filterable file-tree panel (file operation bar)
export type { FileTreeProps } from './tabs/file-tree.tsx';
export { FileTree, filterFileTree } from './tabs/file-tree.tsx';
// Project picker (📁 <project> chip → search dropdown)
export type { ProjectPickerItem, ProjectPickerProps } from './tabs/project-picker.tsx';
export { ProjectPicker } from './tabs/project-picker.tsx';
export type { CanvasTabKindMeta } from './tabs/tab-kinds.ts';
export { CANVAS_TAB_KINDS, kindOpensInCanvas } from './tabs/tab-kinds.ts';
export type {
  CanvasState,
  CanvasTab,
  CanvasTabKind,
  CanvasTabSpec,
  FileTreeNode,
  FileViewMode,
  OpenWithApp,
  OpenWithAppId,
  SubagentItem,
} from './tabs/tab-model.ts';
export { emptyCanvasState } from './tabs/tab-model.ts';
export type { CanvasProviderProps, CanvasTabsApi } from './tabs/use-canvas-tabs.tsx';
export { CanvasProvider, useCanvasTabs } from './tabs/use-canvas-tabs.tsx';
