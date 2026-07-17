/**
 * Desktop settings IPC contract. Composed into the app-wide maps in
 * ../ipc-contract.ts. The renderer Settings view reads/writes `settings:get` /
 * `settings:set`; the main-process handler (./settings-main.ts) owns the single
 * on-disk source of truth (`~/.pi/desktop/settings.json`) and the side effects
 * that make the frozen extensions observe a change (search-key env, mcp-lite
 * registry `mode`). Trusted-sender gated exactly like every other app channel:
 * settings carry API keys + drive an exec-capable agent, so only the main frame
 * of an app-created window may reach them.
 */

export type ThemeFlavor = 'claude' | 'codex';
/** Settings-level mode adds `system` (resolved to light/dark via the OS pref at
 * apply time; the theme store itself only knows light/dark). */
export type ThemeModePref = 'light' | 'dark' | 'system';
export type PermissionMode = 'bypass' | 'reviewer' | 'review-all';
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';
/**
 * Experience level for the model-selection UI (round-12 #4). `user` = simple,
 * automatic model selection (the friendly tier names + Auto); `power` = full
 * control (real model names front-and-center). Read by the model-dropdown /
 * model-manager waves via the settings-store `selectUserMode` selector.
 */
export type UserMode = 'user' | 'power';
/** Valid user modes, in UI (segmented) order. */
export const USER_MODES = ['user', 'power'] as const satisfies readonly UserMode[];
/** Connector surfacing mode; mirrors @pi-desktop/mcp-lite's McpMode. `bash-cli`
 * exposes connectors through the real bash tool via a generated `pi-tool`. */
export type McpMode = 'lite' | 'native' | 'bash-cli';
/** Valid MCP modes, in UI order. */
export const MCP_MODES = ['lite', 'native', 'bash-cli'] as const satisfies readonly McpMode[];

/**
 * Preferred local inference engine (round-12 #4 — the Model Manager's "Prefer MLX
 * (experimental)" toggle). `llamacpp` = the default GGUF backend; `mlx` opts into
 * the Apple-Silicon MLX backend (its foundation lands in a later wave — this is
 * the persisted USER PREFERENCE + the engine badge/note only). Mirrors the
 * catalog `Engine` type, inlined so this contract stays dependency-free. */
export type EnginePreference = 'llamacpp' | 'mlx';
/** Valid engine preferences. */
export const ENGINE_PREFERENCES = [
  'llamacpp',
  'mlx',
] as const satisfies readonly EnginePreference[];

/** The model-capability tier a pinned selection targets. Structural mirror of
 * `ModelTier` in @pi-desktop/harness (inlined so this contract stays dependency-free). */
export type ModelSelectionTier = 'fast' | 'balanced' | 'intelligent';
export const MODEL_SELECTION_TIERS = [
  'fast',
  'balanced',
  'intelligent',
] as const satisfies readonly ModelSelectionTier[];

/**
 * How the app chooses the local model (round-12 model-selection UX). Persisted as
 * the user's DEFAULT and re-applied on each fresh pi session:
 *   - `auto`  → the Auto router picks a tier per-turn (from the harness activeTier);
 *   - `tier`  → pinned to a capability tier (router disabled);
 *   - `model` → pinned to a specific catalog/HF model id (router disabled).
 */
export type ModelSelection =
  | { mode: 'auto' }
  | { mode: 'tier'; tier: ModelSelectionTier }
  | { mode: 'model'; modelId: string };

/** Effort resolution: `auto` derives the level from the active tier (fast→low,
 * balanced→medium, intelligent→high); `level` pins the explicit {@link EffortLevel}. */
export type EffortMode = 'auto' | 'level';
export const EFFORT_MODES = ['auto', 'level'] as const satisfies readonly EffortMode[];

export interface GenerationCapabilities {
  image: boolean;
  video: boolean;
  audio: boolean;
  threeD: boolean;
}

/** Web-search backend keys. Sensitive — persisted to settings.json (mode 0600)
 * and mirrored into the main process env so a (re)spawned pi's web-tools
 * extension reads them (`PI_BRAVE_API_KEY` / `PI_TAVILY_API_KEY`). Empty string
 * means "unset". */
export interface SearchKeys {
  brave: string;
  tavily: string;
}

/** The whole live desktop-settings document. Seeded from onboarding.json on the
 * first read, authoritative thereafter. */
export interface DesktopSettings {
  version: 1;
  theme: { flavor: ThemeFlavor; mode: ThemeModePref };
  permissionMode: PermissionMode;
  effort: EffortLevel;
  /** Experience level driving the model-selection UI (default `user`). */
  userMode: UserMode;
  /** Preferred local inference engine (default `llamacpp`). Set to `mlx` by the
   * Model Manager's "Prefer MLX (experimental)" toggle. */
  enginePreference: EnginePreference;
  /** The model-selection mode (default `{ mode: 'auto' }`). */
  modelSelection: ModelSelection;
  /** Effort resolution mode (default `auto`). `effort` stays the explicit level +
   * the last-resolved level for display. */
  effortMode: EffortMode;
  search: SearchKeys;
  mcpMode: McpMode;
  capabilities: GenerationCapabilities;
  /** User system-instructions prepended to the first prompt of each NEW session
   * (see pi-connect's session-instructions seam). Empty = none. */
  customInstructions: string;
  /** Global SVG icon stroke width; applied to `--pd-icon-stroke` on <html>.
   * Defaults to the token value (1.25). */
  iconStroke: number;
  /** Element-size scale for the sidebar (rows, icons, text, rail); applied to
   * `--pd-sidebar-scale` on <html>. Default 1.0 (no-op). */
  sidebarScale: number;
  /** Element-size scale for the shared dropdown-menu option rows (model dropup +
   * "+" menu); applied to `--pd-menu-scale` on <html>. Default 1.0 (no-op). */
  menuScale: number;
  /** Starred model ids (curated or discovered-HF), surfaced in a Favorites
   * section of the Model Manager. */
  favoriteModels: string[];
  /** Per-model default effort; applied to the effort setting when that model is
   * set active (keyed by model id). */
  modelEffortDefaults: Record<string, EffortLevel>;
  /** Hugging Face access token for gated/private repos (search + gated
   * downloads). Sensitive — persisted to the 0600 settings.json. Empty = unset. */
  hfToken: string;
  /**
   * EXPERIMENTAL (default FALSE): route a submitted prompt through the
   * production coordination harness (the CorpEngine → situation room) instead of
   * the normal solo pi chat turn. Off = the app is byte-for-byte its current
   * self. Also force-enabled for a dev launch via `PI_DESKTOP_CORP=1` (surfaced
   * to the renderer as a `?corp=1` query param). Gates ALL corp wiring.
   */
  experimentalProductionHarness: boolean;
  /**
   * EXPERIMENTAL (default FALSE): wire the on-device GENERATION stack live — the
   * generation socket bridge (`registerGenIpc`), the `generate_image` /
   * `generate_video` pi tools, and the live gen-image canvas surface. Off = the
   * app is byte-for-byte its current self (no gen bridge, no gen tools, no gen
   * surface), so a signed /Applications build stays clean. Also force-enabled for
   * a dev launch via `PI_DESKTOP_GEN=1` (surfaced to the renderer as a `?gen=1`
   * query param). Sibling to {@link experimentalProductionHarness}.
   */
  experimentalGeneration: boolean;
}

/** A partial patch merged over the current document (one level deep on the
 * nested `theme` / `search` / `capabilities` objects). */
export interface DesktopSettingsPatch {
  theme?: Partial<DesktopSettings['theme']>;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  userMode?: UserMode;
  enginePreference?: EnginePreference;
  /** Full replacement of the selection union (no deep-merge). */
  modelSelection?: ModelSelection;
  effortMode?: EffortMode;
  search?: Partial<SearchKeys>;
  mcpMode?: McpMode;
  capabilities?: Partial<GenerationCapabilities>;
  customInstructions?: string;
  iconStroke?: number;
  sidebarScale?: number;
  menuScale?: number;
  /** Full replacement list (renderer read-modify-writes the whole array). */
  favoriteModels?: string[];
  /** Full replacement map (renderer read-modify-writes the whole record). */
  modelEffortDefaults?: Record<string, EffortLevel>;
  hfToken?: string;
  /** Experimental production-harness toggle (default FALSE). */
  experimentalProductionHarness?: boolean;
  /** Experimental generation-stack toggle (default FALSE). */
  experimentalGeneration?: boolean;
}

/** Icon-stroke bounds — mirrors the IconStrokeControl slider range. */
export const ICON_STROKE_MIN = 1;
export const ICON_STROKE_MAX = 2.5;
export const ICON_STROKE_DEFAULT = 1.25;

/** Element-size scale bounds — shared by the sidebar + menu scale sliders.
 * Both default to 1.0 so an untouched install is byte-identical to today. */
export const UI_SCALE_MIN = 0.8; // FEEL — owner may retune
export const UI_SCALE_MAX = 1.5; // FEEL
export const UI_SCALE_DEFAULT = 1.0;

export type SettingsInvokeMap = {
  /** Current settings, seeded from onboarding.json + the mcp registry on first read. */
  'settings:get': { request: undefined; response: DesktopSettings };
  /** Merge a patch, persist, apply side effects (env + mcp registry mode); returns
   * the full new document. */
  'settings:set': { request: { patch: DesktopSettingsPatch }; response: DesktopSettings };
};

export const SETTINGS_INVOKE_CHANNELS = [
  'settings:get',
  'settings:set',
] as const satisfies readonly (keyof SettingsInvokeMap)[];
