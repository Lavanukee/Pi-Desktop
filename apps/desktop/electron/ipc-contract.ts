/**
 * The app's typed IPC surface. Main, preload, and renderer all import from
 * this single module, so a contract change breaks the compile on every side.
 * Channel maps must be `type` aliases (not interfaces) to satisfy the
 * IpcInvokeMap / IpcEventMap constraints in @pi-desktop/shared.
 */
import type { CanvasState } from '@pi-desktop/browser-use/protocol';
import type { IpcClient, IpcEventMap, IpcInvokeMap } from '@pi-desktop/shared';
import { AFM_INVOKE_CHANNELS, type AfmInvokeMap } from './afm/afm-contract';
import {
  BROWSER_AGENT_INVOKE_CHANNELS,
  type BrowserAgentEventMap,
  type BrowserAgentInvokeMap,
} from './canvas/browser-agent-contract';
import {
  BROWSER_INVOKE_CHANNELS,
  type BrowserEventMap,
  type BrowserInvokeMap,
} from './canvas/browser-contract';
import {
  CONNECTORS_INVOKE_CHANNELS,
  type ConnectorsInvokeMap,
} from './connectors/connectors-contract';
import { CORP_INVOKE_CHANNELS, type CorpEventMap, type CorpInvokeMap } from './corp/corp-contract';
import { GEN_CATALOG_INVOKE_CHANNELS, type GenCatalogInvokeMap } from './gen/gen-ipc-contract';
import { IMPORT_INVOKE_CHANNELS, type ImportInvokeMap } from './import/import-contract';
import { PI_INVOKE_CHANNELS, type PiEventMap, type PiInvokeMap } from './pi/contract';
import { PROJECT_INVOKE_CHANNELS, type ProjectInvokeMap } from './project/project-contract';
import { SETTINGS_INVOKE_CHANNELS, type SettingsInvokeMap } from './settings/settings-contract';
import { SKILLS_INVOKE_CHANNELS, type SkillsInvokeMap } from './skills/skills-contract';
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
  /** Write UTF-8 contents back to a single file for live canvas editing.
   * Fenced to allowed roots (cwd/project/session dirs); refuses paths outside
   * them and refuses to create a file where a directory exists. */
  'fs:write-file': {
    request: { path: string; content: string };
    response: { ok: boolean; bytes?: number; error?: string };
  };
};

export const FS_INVOKE_CHANNELS = [
  'fs:list-files',
  'fs:list-sessions',
  'fs:read-session',
  'fs:list-tree',
  'fs:read-file',
  'fs:write-file',
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
  /** The launch mode of the currently-running server, so the app knows whether
   * vision (multimodal) is already on before requesting an on-demand restart. */
  launchMode?: 'fast-text' | 'multimodal';
  error?: string;
}

/** A speed variant a model can launch with (MTP / EAGLE3 / DFlash), surfaced for
 * the model-manager variant dropdown. */
export interface LlmSpecVariant {
  method: 'mtp' | 'eagle3' | 'dflash';
  /** HF repo the draft GGUF lives in (EAGLE3/DFlash), when separate. */
  draftRepo?: string;
  /** True when the head is embedded in the main GGUF (no separate draft). */
  embedded?: boolean;
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
  /** DEFAULT speculative-decoding speed method this entry launches with, if any. */
  spec?: 'mtp' | 'eagle3' | 'dflash';
  /** All speed variants available (for the [MTP / EAGLE3 / DFlash] dropdown). */
  variants?: LlmSpecVariant[];
  vision: boolean;
  downloaded: boolean;
  recommended: boolean;
  /** HF repo id (e.g. "unsloth/gemma-4-E2B-it-GGUF") — for the Advanced view. */
  hfRepo?: string;
  /** Inference engine (llamacpp default; mlx is a later-wave, Apple-Silicon opt-in). */
  engine?: 'llamacpp' | 'mlx';
  /** HF publisher handle (e.g. "unsloth") + whether it is in the reliable allowlist. */
  publisher?: { handle: string; reliable: boolean };
  /** Coarse tier hint (fast / balanced / intelligent) for grouping/sorting. */
  tier?: 'fast' | 'balanced' | 'intelligent';
  /** True when the quants are multi-shard (shard-join download is a follow-up). */
  sharded?: boolean;
  /** True when the source HF repo is gated (needs an accepted licence / token). */
  gated?: boolean;
  /** Where this entry came from: the hand-curated catalog or a Browse-HF add. */
  source?: 'curated' | 'hf';
  /** True only for HEAD-verified curated repos; false for discovered/reserved adds. */
  verified?: boolean;
}

export interface LlmHardware {
  totalRamGB: number;
  chip: string | null;
  isAppleSilicon: boolean;
}

/** The hardware-detected recommendation (from packages/inference `recommend`),
 * surfaced so the Model Manager can show the pick + its rationale prominently. */
/** One non-power-user pick in the "Recommended for your Mac" simple set. */
export interface LlmSimplePick {
  role: 'speed' | 'vision' | 'utility';
  modelId: string;
  displayName: string;
  quant: string;
  launchMode: 'fast-text' | 'multimodal';
  /** Speed method this pick runs with (fast-text picks only). */
  spec?: 'mtp' | 'eagle3' | 'dflash';
  vision: boolean;
}

/** One tier resolved for this machine's RAM (from `resolveTierModels`), carried
 * to the renderer so the Auto router + tier dropdown never re-derive it. */
export interface LlmTierPick {
  modelId: string;
  displayName: string;
  quant: string;
  launchMode: 'fast-text' | 'multimodal';
  spec?: 'mtp' | 'eagle3' | 'dflash';
  vision: boolean;
  /** Download size in bytes (0 = unverified) for the "N GB" auto-download copy. */
  bytes: number;
  /** Whether the pick's main file is already on disk. */
  downloaded: boolean;
}

export interface LlmRecommendation {
  modelId: string;
  quant: string;
  tier: string;
  rationale: string;
  /** 1–3 clearly-labelled picks for non-power-users (speed / vision / helper). */
  simpleSet: LlmSimplePick[];
  /** The 3 tier picks resolved for this Mac (fast / balanced / intelligent). */
  tierModels?: Record<'fast' | 'balanced' | 'intelligent', LlmTierPick>;
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
  /** Start OR resume a download (resumes from the `.part` sidecar automatically).
   * `hfToken` (from settings) authorizes gated-repo files; public repos ignore it. */
  'llm:download-model': {
    request: { modelId: string; quant?: string; hfToken?: string };
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
  /** Start the server for a model. `launchMode:'multimodal'` requests an
   * on-demand vision launch (fetches the mmproj sibling, drops MTP); omitted /
   * 'fast-text' is the default speed launch. */
  'llm:start-server': {
    request: { modelId: string; quant?: string; launchMode?: 'fast-text' | 'multimodal' };
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
// Hugging Face model-search channels (Browse-HF view; proxied to the inference
// supervisor, which owns @pi-desktop/inference's hf-search + the dynamic
// registry of discovered models). Structural DTO mirrors of the package's
// HfModelHit / HfGgufFile keep this contract free of a package import.
// ---------------------------------------------------------------------------

/** One HF search hit (mirror of @pi-desktop/inference `HfModelHit`). */
export interface HfModelHitDTO {
  id: string;
  author: string;
  name: string;
  downloads: number;
  likes: number;
  tags: string[];
  gated: boolean;
  pipelineTag?: string;
  updatedAt?: string;
  likesRecent?: number;
}

/** One GGUF file in a repo (mirror of `HfGgufFile`) + a RAM estimate the
 * supervisor computes so the quant picker can badge fit without the package. */
export interface HfGgufFileDTO {
  path: string;
  sizeBytes?: number;
  quant?: string;
  sha256?: string;
  mmproj?: boolean;
  mtp?: boolean;
  /** Estimated minimum system RAM (GB), via `estimateRamGB`; undefined if unsized. */
  minRamGB?: number;
}

/** Sort orders exposed in the Browse-HF UI (mapped to HF's raw sort keys).
 * `trending` (HF `trendingScore`) is the default used to surface a populated
 * "trending on HF" list the moment the Browse view opens (Round-10 #20b). */
export type HfSortOption = 'trending' | 'downloads' | 'likes' | 'recent';

export type HfInvokeMap = {
  /** Text + filter search over HF GGUF repos (rate-limit aware; errors are
   * returned, not thrown, so the UI can show a message instead of crashing). */
  'hf:search': {
    request: {
      query: string;
      family?: string;
      task?: string;
      gated?: boolean;
      minLikes?: number;
      sort?: HfSortOption;
      limit?: number;
      hfToken?: string;
    };
    response: { hits: HfModelHitDTO[]; error?: string; rateLimited?: boolean };
  };
  /** List a repo's `.gguf` files (quant/size/sha/mmproj/mtp + RAM estimate). */
  'hf:list-files': {
    request: { repoId: string; contextWindow?: number; hfToken?: string };
    response: { files: HfGgufFileDTO[]; gated?: boolean; error?: string };
  };
  /** Adapt an HF hit + chosen file into a catalog entry and register it with the
   * supervisor (persisted), so the existing llm:download-model/start-server/… act
   * on it by id exactly like a curated model. */
  'hf:register': {
    request: {
      hit: HfModelHitDTO;
      file: HfGgufFileDTO;
      mmproj?: HfGgufFileDTO;
      mtpFile?: HfGgufFileDTO;
      contextWindow?: number;
    };
    response: { modelId: string; entry: LlmCatalogEntry };
  };
};

export const HF_INVOKE_CHANNELS = [
  'hf:search',
  'hf:list-files',
  'hf:register',
] as const satisfies readonly (keyof HfInvokeMap)[];

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

/** Identifier of an app in the file "Open with" list. Round-8: widened to a
 * free-form string — the desktop supplies real system apps (bundle id or `.app`
 * path). `'default'` still routes to the OS default handler; the legacy named
 * ids (`vscode-insiders` / `terminal` / `xcode`) stay valid for back-compat. */
export type CanvasOpenWithAppId = string;

/** One app the canvas "Open with" split button can shell out to (round-8 #14).
 * Mirrors @pi-desktop/canvas's `OpenWithApp` (kept inline so the electron
 * contract stays free of the canvas React package). The `iconDataUrl` is the
 * app's system icon extracted to a PNG data URL by the main process. */
export interface CanvasOpenApp {
  id: CanvasOpenWithAppId;
  name: string;
  iconDataUrl?: string;
}

export type CanvasInvokeMap = {
  /** Hand the current artifact to main and open/focus the pop-out window. */
  'canvas:popout': { request: { artifact: CanvasArtifactPayload }; response: { ok: boolean } };
  /** The pop-out window fetches the artifact main is holding for it. */
  'canvas:get-popout': { request: undefined; response: { artifact: CanvasArtifactPayload | null } };
  /** Browser operation bar "open in external browser" → shell.openExternal. */
  'canvas:open-external': { request: { url: string }; response: { ok: boolean } };
  /** The apps that can open a given file (LaunchServices + a pragmatic set), each
   * with a system-icon data URL, plus the detected default app id (round-8 #14).
   * Icons are extracted + cached lazily in main. */
  'canvas:list-open-apps': {
    request: { path: string };
    response: { apps: CanvasOpenApp[]; defaultAppId: string | null };
  };
  /** File operation bar "Open ▾" → shell out to open the file in the chosen app. */
  'canvas:open-with': {
    request: { path: string; appId: CanvasOpenWithAppId };
    response: { ok: boolean; error?: string };
  };
  /** File operation bar "Open in folder" → shell.showItemInFolder. */
  'canvas:reveal': { request: { path: string }; response: { ok: boolean } };
  /** Renderer → main: report a compact snapshot of what's on the canvas right now
   * (canvas-awareness). Main caches it and serves it to the pi child's `context`
   * hook (browser url/title re-enriched from the live view). Debounced by the
   * renderer; pushed on surface / active-tab changes. */
  'canvas:report-state': { request: { state: CanvasState }; response: { ok: boolean } };
};

export const CANVAS_INVOKE_CHANNELS = [
  'canvas:popout',
  'canvas:get-popout',
  'canvas:open-external',
  'canvas:list-open-apps',
  'canvas:open-with',
  'canvas:reveal',
  'canvas:report-state',
] as const satisfies readonly (keyof CanvasInvokeMap)[];

export type AppInvokeMap = CoreInvokeMap &
  FsInvokeMap &
  LlmInvokeMap &
  HfInvokeMap &
  AfmInvokeMap &
  SettingsInvokeMap &
  CanvasInvokeMap &
  ProjectInvokeMap &
  ConnectorsInvokeMap &
  SkillsInvokeMap &
  ImportInvokeMap &
  GenCatalogInvokeMap &
  BrowserInvokeMap &
  BrowserAgentInvokeMap &
  PtyInvokeMap &
  CorpInvokeMap &
  PiInvokeMap;

/** Runtime allowlist for the preload's invoke passthrough: only channels in
 * the contract ever reach ipcMain (see preload.ts). `satisfies` checks
 * membership; MissingChannels checks exhaustiveness, so adding a channel to
 * the map without listing it here is a compile error. */
export const APP_INVOKE_CHANNELS = [
  'app:get-info',
  ...FS_INVOKE_CHANNELS,
  ...LLM_INVOKE_CHANNELS,
  ...HF_INVOKE_CHANNELS,
  ...AFM_INVOKE_CHANNELS,
  ...SETTINGS_INVOKE_CHANNELS,
  ...CANVAS_INVOKE_CHANNELS,
  ...PROJECT_INVOKE_CHANNELS,
  ...CONNECTORS_INVOKE_CHANNELS,
  ...SKILLS_INVOKE_CHANNELS,
  ...IMPORT_INVOKE_CHANNELS,
  ...GEN_CATALOG_INVOKE_CHANNELS,
  ...BROWSER_INVOKE_CHANNELS,
  ...BROWSER_AGENT_INVOKE_CHANNELS,
  ...PTY_INVOKE_CHANNELS,
  ...CORP_INVOKE_CHANNELS,
  ...PI_INVOKE_CHANNELS,
] as const satisfies readonly (keyof AppInvokeMap)[];

type MissingChannels = Exclude<keyof AppInvokeMap, (typeof APP_INVOKE_CHANNELS)[number]>;
const _assertAllChannelsListed: MissingChannels extends never ? true : MissingChannels = true;
void _assertAllChannelsListed;

export type AppEventMap = {
  /** Pushed by main on did-finish-load — typically before React mounts, which
   * exercises the pre-mount event buffer end to end. */
  'app:boot': { sentAt: number };
  /** A menu accelerator that the RENDERER must action (main has no view state).
   * `close-tab` (⌘W) closes the active canvas tab / current chat — NOT the window
   * (⌘⇧W / the red button close the window). See main.ts installAppMenu. */
  'app:accelerator': { action: 'close-tab' };
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
  BrowserAgentEventMap &
  PtyEventMap &
  CorpEventMap &
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
