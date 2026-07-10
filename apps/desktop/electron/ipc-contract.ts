/**
 * The app's typed IPC surface. Main, preload, and renderer all import from
 * this single module, so a contract change breaks the compile on every side.
 * Channel maps must be `type` aliases (not interfaces) to satisfy the
 * IpcInvokeMap / IpcEventMap constraints in @pi-desktop/shared.
 */
import type { IpcClient, IpcEventMap, IpcInvokeMap } from '@pi-desktop/shared';
import { AFM_INVOKE_CHANNELS, type AfmInvokeMap } from './afm/afm-contract';
import {
  BROWSER_INVOKE_CHANNELS,
  type BrowserEventMap,
  type BrowserInvokeMap,
} from './canvas/browser-contract';
import { IMPORT_INVOKE_CHANNELS, type ImportInvokeMap } from './import/import-contract';
import { PI_INVOKE_CHANNELS, type PiEventMap, type PiInvokeMap } from './pi/contract';
import { SETTINGS_INVOKE_CHANNELS, type SettingsInvokeMap } from './settings/settings-contract';
import { PTY_INVOKE_CHANNELS, type PtyEventMap, type PtyInvokeMap } from './terminal/pty-contract';

export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  /** `process.platform` value, e.g. `darwin`. */
  platform: string;
}

/** Core app channels, registered exhaustively via registerIpcHandlers in
 * main.ts. pi channels live in ./pi/contract.ts and are registered separately
 * (their handlers need the sender WebContents to route to a per-window
 * bridge); both groups compose into the maps below for preload/renderer. */
export type CoreInvokeMap = {
  'app:get-info': { request: undefined; response: AppInfo };
};

// ---------------------------------------------------------------------------
// Filesystem channels (read-only; back the composer picker + session sidebar)
// ---------------------------------------------------------------------------

/** One recent pi session, summarised from its JSONL header + first user turn. */
export interface SessionSummary {
  file: string;
  id: string;
  cwd: string;
  cwdLabel: string;
  startedAt: string;
  modifiedAt: string;
  messageCount: number;
  firstUserText: string | null;
  title: string;
}

/**
 * One node in a bounded directory tree (fs:list-tree). Structural mirror of
 * @pi-desktop/canvas's `FileTreeNode` — kept as a plain contract type so the
 * main bundle never imports the canvas React package; the renderer passes the
 * shape straight through to `CanvasTab.fileTree`.
 */
export interface FsTreeNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: FsTreeNode[];
}

export type FsInvokeMap = {
  /** Fuzzy file search from a cwd, for @-mention autocomplete. */
  'fs:list-files': {
    request: { cwd?: string; query: string; limit?: number };
    response: Array<{ path: string; rel: string }>;
  };
  /** Recent sessions, optionally filtered to one cwd (sidebar). */
  'fs:list-sessions': { request: { cwd?: string } | undefined; response: SessionSummary[] };
  /** Raw session JSONL text (fenced to the sessions dir) for rehydration. */
  'fs:read-session': { request: { file: string }; response: { text: string | null } };
  /** A bounded directory tree rooted at `root` (the file operation bar's tree
   * panel). Depth/entry-count capped; the usual junk dirs are skipped. */
  'fs:list-tree': {
    request: { root: string; depth?: number };
    response: { root: string; tree: FsTreeNode[] };
  };
  /** UTF-8 contents of a single file, size-capped, for the live canvas file
   * surface. `tooLarge`/`binary` gate streaming huge/binary payloads. */
  'fs:read-file': {
    request: { path: string; maxBytes?: number };
    response: {
      text: string | null;
      truncated: boolean;
      tooLarge: boolean;
      binary: boolean;
      bytes: number;
    };
  };
};

export const FS_INVOKE_CHANNELS = [
  'fs:list-files',
  'fs:list-sessions',
  'fs:read-session',
  'fs:list-tree',
  'fs:read-file',
] as const satisfies readonly (keyof FsInvokeMap)[];

// ---------------------------------------------------------------------------
// Inference channels (utilityProcess "inference-supervisor"; folds in W4)
// ---------------------------------------------------------------------------

export interface LlmModelInfo {
  id: string;
  displayName: string;
  quant: string;
  contextWindow: number;
}

export type LlmPhase = 'idle' | 'downloading' | 'starting' | 'ready' | 'error';

export interface LlmStatus {
  phase: LlmPhase;
  serverRunning: boolean;
  baseUrl: string | null;
  model: LlmModelInfo | null;
  metrics: { lastTps?: number; avgTps?: number } | null;
  downloadedModelIds: string[];
  error?: string;
}

export interface LlmCatalogEntry {
  id: string;
  displayName: string;
  quants: Array<{ quant: string; bytes: number }>;
  minRamGB: number;
  contextWindow: number;
  input: Array<'text' | 'image'>;
  license: string;
  /** Multi-token-prediction speedup (embedded head or sibling file). */
  mtp: boolean;
  vision: boolean;
  downloaded: boolean;
  recommended: boolean;
}

export interface LlmHardware {
  totalRamGB: number;
  chip: string | null;
  isAppleSilicon: boolean;
}

/** The hardware-detected recommendation (from packages/inference `recommend`),
 * surfaced so the Model Manager can show the pick + its rationale prominently. */
export interface LlmRecommendation {
  modelId: string;
  quant: string;
  tier: string;
  rationale: string;
}

export type LlmInvokeMap = {
  'llm:get-status': { request: undefined; response: LlmStatus };
  'llm:list-catalog': {
    request: undefined;
    response: {
      models: LlmCatalogEntry[];
      hardware: LlmHardware;
      recommendedModelId: string | null;
      recommendation: LlmRecommendation | null;
    };
  };
  /** Start OR resume a download (resumes from the `.part` sidecar automatically). */
  'llm:download-model': {
    request: { modelId: string; quant?: string };
    response: { success: boolean; error?: string; paused?: boolean; cancelled?: boolean };
  };
  /** Abort the in-flight download but KEEP the `.part` file (download-model resumes it). */
  'llm:pause-download': { request: undefined; response: { success: boolean } };
  /** Abort the in-flight download AND discard its `.part` file. */
  'llm:cancel-download': { request: undefined; response: { success: boolean } };
  /** Delete a downloaded model's files (frees disk). */
  'llm:delete-model': {
    request: { modelId: string };
    response: { success: boolean; error?: string };
  };
  /** Re-hash a downloaded model against its catalog sha256. */
  'llm:verify-model': {
    request: { modelId: string; quant?: string };
    response: {
      ok: boolean;
      files: Array<{ file: string; ok: boolean; checked: boolean }>;
      error?: string;
    };
  };
  'llm:start-server': {
    request: { modelId: string; quant?: string };
    response: { success: boolean; baseUrl?: string; error?: string };
  };
  'llm:stop-server': { request: undefined; response: { success: boolean } };
};

export const LLM_INVOKE_CHANNELS = [
  'llm:get-status',
  'llm:list-catalog',
  'llm:download-model',
  'llm:pause-download',
  'llm:cancel-download',
  'llm:delete-model',
  'llm:verify-model',
  'llm:start-server',
  'llm:stop-server',
] as const satisfies readonly (keyof LlmInvokeMap)[];

// ---------------------------------------------------------------------------
// Canvas channels (artifact pop-out into a separate app window)
// ---------------------------------------------------------------------------

/** JSON-serializable mirror of @pi-desktop/canvas's `Artifact`. Kept structural
 * (not an import) so the electron contract stays free of the canvas React
 * package; the renderer maps its real Artifact onto this shape at the boundary. */
export interface CanvasArtifactPayload {
  id: string;
  title?: string;
  filename?: string;
  content: {
    kind: string;
    text: string;
    language?: string;
    mimeType?: string;
  };
}

/** The apps the canvas file operation bar's "Open ▾" dropdown shells out to.
 * Mirrors @pi-desktop/canvas's `OpenWithAppId` (kept inline so the electron
 * contract stays free of the canvas React package). */
export type CanvasOpenWithAppId = 'vscode-insiders' | 'default' | 'terminal' | 'xcode';

export type CanvasInvokeMap = {
  /** Hand the current artifact to main and open/focus the pop-out window. */
  'canvas:popout': { request: { artifact: CanvasArtifactPayload }; response: { ok: boolean } };
  /** The pop-out window fetches the artifact main is holding for it. */
  'canvas:get-popout': { request: undefined; response: { artifact: CanvasArtifactPayload | null } };
  /** Browser operation bar "open in external browser" → shell.openExternal. */
  'canvas:open-external': { request: { url: string }; response: { ok: boolean } };
  /** File operation bar "Open ▾" → shell out to open the file in the chosen app. */
  'canvas:open-with': {
    request: { path: string; appId: CanvasOpenWithAppId };
    response: { ok: boolean; error?: string };
  };
  /** File operation bar "Open in folder" → shell.showItemInFolder. */
  'canvas:reveal': { request: { path: string }; response: { ok: boolean } };
};

export const CANVAS_INVOKE_CHANNELS = [
  'canvas:popout',
  'canvas:get-popout',
  'canvas:open-external',
  'canvas:open-with',
  'canvas:reveal',
] as const satisfies readonly (keyof CanvasInvokeMap)[];

export type AppInvokeMap = CoreInvokeMap &
  FsInvokeMap &
  LlmInvokeMap &
  AfmInvokeMap &
  SettingsInvokeMap &
  CanvasInvokeMap &
  ImportInvokeMap &
  BrowserInvokeMap &
  PtyInvokeMap &
  PiInvokeMap;

/** Runtime allowlist for the preload's invoke passthrough: only channels in
 * the contract ever reach ipcMain (see preload.ts). `satisfies` checks
 * membership; MissingChannels checks exhaustiveness, so adding a channel to
 * the map without listing it here is a compile error. */
export const APP_INVOKE_CHANNELS = [
  'app:get-info',
  ...FS_INVOKE_CHANNELS,
  ...LLM_INVOKE_CHANNELS,
  ...AFM_INVOKE_CHANNELS,
  ...SETTINGS_INVOKE_CHANNELS,
  ...CANVAS_INVOKE_CHANNELS,
  ...IMPORT_INVOKE_CHANNELS,
  ...BROWSER_INVOKE_CHANNELS,
  ...PTY_INVOKE_CHANNELS,
  ...PI_INVOKE_CHANNELS,
] as const satisfies readonly (keyof AppInvokeMap)[];

type MissingChannels = Exclude<keyof AppInvokeMap, (typeof APP_INVOKE_CHANNELS)[number]>;
const _assertAllChannelsListed: MissingChannels extends never ? true : MissingChannels = true;
void _assertAllChannelsListed;

export type AppEventMap = {
  /** Pushed by main on did-finish-load — typically before React mounts, which
   * exercises the pre-mount event buffer end to end. */
  'app:boot': { sentAt: number };
  /** Inference supervisor state (server/model/TPS) for the composer footer. */
  'llm:status': LlmStatus;
  'llm:download-progress': {
    modelId: string;
    file: string;
    received: number;
    total: number | null;
    fraction: number | null;
  };
  /** Pushed to the pop-out window when a fresh artifact is popped out while it
   * is already open, so the standalone canvas re-renders without a reload. */
  'canvas:popout-artifact': CanvasArtifactPayload;
} & BrowserEventMap &
  PtyEventMap &
  PiEventMap;

/** Shape of `window.piDesktop` as exposed by the preload script. */
export interface PiDesktopBridge {
  invoke: IpcClient<AppInvokeMap>['invoke'];
  onEvent<K extends keyof AppEventMap & string>(
    channel: K,
    listener: (payload: AppEventMap[K]) => void,
  ): () => void;
}

// Static assertions: keep the maps assignable to the shared constraints.
const _assertInvokeMap: IpcInvokeMap = {} as AppInvokeMap;
const _assertEventMap: IpcEventMap = {} as AppEventMap;
void _assertInvokeMap;
void _assertEventMap;
