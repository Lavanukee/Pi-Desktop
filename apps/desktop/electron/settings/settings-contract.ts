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
/** Connector surfacing mode; mirrors @pi-desktop/mcp-lite's McpMode. `bash-cli`
 * exposes connectors through the real bash tool via a generated `pi-tool`. */
export type McpMode = 'lite' | 'native' | 'bash-cli';
/** Valid MCP modes, in UI order. */
export const MCP_MODES = ['lite', 'native', 'bash-cli'] as const satisfies readonly McpMode[];

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
  search: SearchKeys;
  mcpMode: McpMode;
  capabilities: GenerationCapabilities;
  /** User system-instructions prepended to the first prompt of each NEW session
   * (see pi-connect's session-instructions seam). Empty = none. */
  customInstructions: string;
  /** Global SVG icon stroke width; applied to `--pd-icon-stroke` on <html>.
   * Defaults to the token value (1.25). */
  iconStroke: number;
  /** Starred model ids (curated or discovered-HF), surfaced in a Favorites
   * section of the Model Manager. */
  favoriteModels: string[];
  /** Per-model default effort; applied to the effort setting when that model is
   * set active (keyed by model id). */
  modelEffortDefaults: Record<string, EffortLevel>;
  /** Hugging Face access token for gated/private repos (search + gated
   * downloads). Sensitive — persisted to the 0600 settings.json. Empty = unset. */
  hfToken: string;
}

/** A partial patch merged over the current document (one level deep on the
 * nested `theme` / `search` / `capabilities` objects). */
export interface DesktopSettingsPatch {
  theme?: Partial<DesktopSettings['theme']>;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  search?: Partial<SearchKeys>;
  mcpMode?: McpMode;
  capabilities?: Partial<GenerationCapabilities>;
  customInstructions?: string;
  iconStroke?: number;
  /** Full replacement list (renderer read-modify-writes the whole array). */
  favoriteModels?: string[];
  /** Full replacement map (renderer read-modify-writes the whole record). */
  modelEffortDefaults?: Record<string, EffortLevel>;
  hfToken?: string;
}

/** Icon-stroke bounds — mirrors the IconStrokeControl slider range. */
export const ICON_STROKE_MIN = 1;
export const ICON_STROKE_MAX = 2.5;
export const ICON_STROKE_DEFAULT = 1.25;

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
