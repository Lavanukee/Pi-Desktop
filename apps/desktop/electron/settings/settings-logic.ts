/**
 * Pure settings normalization/merge/seed logic — kept electron-free and
 * IO-free so it is unit-testable in plain Node (settings-main.ts does the fs).
 * Every field is guarded on read so a hand-edited or partially-written
 * settings.json can never brick the app; unknown values fall back to defaults.
 */
import type { OnboardingChoices } from '../import/import-contract';
import {
  type AdvancedSettings,
  type ChatOrganization,
  type ChatProject,
  DEFAULT_ADVANCED,
  type DesktopSettings,
  type DesktopSettingsPatch,
  EFFORT_MODES,
  type EffortLevel,
  ENGINE_PREFERENCES,
  type EnginePreference,
  ICON_STROKE_DEFAULT,
  ICON_STROKE_MAX,
  ICON_STROKE_MIN,
  MCP_MODES,
  type McpMode,
  MODEL_SELECTION_TIERS,
  type ModelSelection,
  type ModelSelectionTier,
  type PermissionMode,
  type ThemeFlavor,
  type ThemeModePref,
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  USER_MODES,
} from './settings-contract';

const FLAVORS: readonly ThemeFlavor[] = ['claude', 'codex'];
const MODES: readonly ThemeModePref[] = ['light', 'dark', 'system'];
const PERMISSION_MODES: readonly PermissionMode[] = ['bypass', 'reviewer', 'review-all'];
const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'max'];
const ENGINE_PREFS: readonly EnginePreference[] = ENGINE_PREFERENCES;

/** Normalize an untrusted model-selection union, falling back on anything invalid. */
function clampModelSelection(value: unknown, fallback: ModelSelection): ModelSelection {
  if (typeof value !== 'object' || value === null) return fallback;
  const v = value as Record<string, unknown>;
  if (
    v.mode === 'tier' &&
    typeof v.tier === 'string' &&
    (MODEL_SELECTION_TIERS as readonly string[]).includes(v.tier)
  ) {
    return { mode: 'tier', tier: v.tier as ModelSelectionTier };
  }
  if (v.mode === 'model' && typeof v.modelId === 'string' && v.modelId.length > 0) {
    return { mode: 'model', modelId: v.modelId };
  }
  if (v.mode === 'auto') return { mode: 'auto' };
  return fallback;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  version: 1,
  theme: { flavor: 'claude', mode: 'system' },
  permissionMode: 'reviewer',
  effort: 'medium',
  userMode: 'user',
  enginePreference: 'llamacpp',
  modelSelection: { mode: 'auto' },
  effortMode: 'auto',
  search: { brave: '', tavily: '' },
  mcpMode: 'lite',
  capabilities: { image: false, video: false, audio: false, threeD: false },
  customInstructions: '',
  iconStroke: ICON_STROKE_DEFAULT,
  sidebarScale: UI_SCALE_DEFAULT,
  menuScale: UI_SCALE_DEFAULT,
  favoriteModels: [],
  modelEffortDefaults: {},
  hfToken: '',
  experimentalProductionHarness: false,
  experimentalGeneration: false,
  advanced: DEFAULT_ADVANCED,
  chatOrg: { projects: [], assignments: {}, pinned: [], titles: {} },
  hideDeleteChatConfirm: false,
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Unique list of non-empty strings (favorite model ids); junk → []. */
function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v === 'string' && v.length > 0) seen.add(v);
  }
  return [...seen];
}

/** A record<string,string> keeping only string→string entries. */
function strMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

/** Normalize the untrusted chat-organization blob (projects/assignments/pins/renames). */
function clampChatOrg(value: unknown): ChatOrganization {
  const o = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const projects: ChatProject[] = Array.isArray(o.projects)
    ? o.projects
        .filter((p): p is { id: unknown; name: unknown } => typeof p === 'object' && p !== null)
        .map((p) => ({ id: str(p.id, ''), name: str(p.name, '') }))
        .filter((p) => p.id.length > 0 && p.name.length > 0)
    : [];
  return {
    projects,
    assignments: strMap(o.assignments),
    pinned: strArray(o.pinned),
    titles: strMap(o.titles),
  };
}

/** Normalize the untrusted advanced knobs (sampling + reasoning) with bounds. */
function clampAdvanced(value: unknown): AdvancedSettings {
  const o = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const s = (typeof o.sampling === 'object' && o.sampling !== null ? o.sampling : {}) as Record<
    string,
    unknown
  >;
  const r = (typeof o.reasoning === 'object' && o.reasoning !== null ? o.reasoning : {}) as Record<
    string,
    unknown
  >;
  const ds = DEFAULT_ADVANCED.sampling;
  const dr = DEFAULT_ADVANCED.reasoning;
  return {
    sampling: {
      temperature: num(s.temperature, ds.temperature, 0, 2),
      topP: num(s.topP, ds.topP, 0, 1),
      topK: num(s.topK, ds.topK, 0, 500),
      minP: num(s.minP, ds.minP, 0, 1),
      repetitionPenalty: num(s.repetitionPenalty, ds.repetitionPenalty, 0, 2),
      presencePenalty: num(s.presencePenalty, ds.presencePenalty, -2, 2),
      maxTokens: Math.round(num(s.maxTokens, ds.maxTokens, 0, 1_000_000)),
    },
    reasoning: {
      preserve: bool(r.preserve, dr.preserve),
      budget: Math.round(num(r.budget, dr.budget, -1, 1_000_000)),
      budgetMessage: str(r.budgetMessage, dr.budgetMessage),
    },
  };
}

/** Record<modelId, EffortLevel>, dropping entries with an invalid effort. */
function effortMap(value: unknown): Record<string, EffortLevel> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, EffortLevel> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v)) {
      out[key] = v as EffortLevel;
    }
  }
  return out;
}

/** Normalize an untrusted parsed object into a fully-valid DesktopSettings. */
export function clampSettings(raw: unknown): DesktopSettings {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const theme = (typeof o.theme === 'object' && o.theme !== null ? o.theme : {}) as Record<
    string,
    unknown
  >;
  const search = (typeof o.search === 'object' && o.search !== null ? o.search : {}) as Record<
    string,
    unknown
  >;
  const caps = (
    typeof o.capabilities === 'object' && o.capabilities !== null ? o.capabilities : {}
  ) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    version: 1,
    theme: {
      flavor: oneOf(theme.flavor, FLAVORS, d.theme.flavor),
      mode: oneOf(theme.mode, MODES, d.theme.mode),
    },
    permissionMode: oneOf(o.permissionMode, PERMISSION_MODES, d.permissionMode),
    effort: oneOf(o.effort, EFFORT_LEVELS, d.effort),
    userMode: oneOf(o.userMode, USER_MODES, d.userMode),
    enginePreference: oneOf(o.enginePreference, ENGINE_PREFS, d.enginePreference),
    modelSelection: clampModelSelection(o.modelSelection, d.modelSelection),
    effortMode: oneOf(o.effortMode, EFFORT_MODES, d.effortMode),
    search: { brave: str(search.brave, ''), tavily: str(search.tavily, '') },
    mcpMode: oneOf(o.mcpMode, MCP_MODES, d.mcpMode),
    capabilities: {
      image: bool(caps.image, d.capabilities.image),
      video: bool(caps.video, d.capabilities.video),
      audio: bool(caps.audio, d.capabilities.audio),
      threeD: bool(caps.threeD, d.capabilities.threeD),
    },
    customInstructions: str(o.customInstructions, d.customInstructions),
    iconStroke: num(o.iconStroke, d.iconStroke, ICON_STROKE_MIN, ICON_STROKE_MAX),
    sidebarScale: num(o.sidebarScale, d.sidebarScale, UI_SCALE_MIN, UI_SCALE_MAX),
    menuScale: num(o.menuScale, d.menuScale, UI_SCALE_MIN, UI_SCALE_MAX),
    favoriteModels: strArray(o.favoriteModels),
    modelEffortDefaults: effortMap(o.modelEffortDefaults),
    hfToken: str(o.hfToken, d.hfToken),
    experimentalProductionHarness: bool(
      o.experimentalProductionHarness,
      d.experimentalProductionHarness,
    ),
    experimentalGeneration: bool(o.experimentalGeneration, d.experimentalGeneration),
    advanced: clampAdvanced(o.advanced),
    chatOrg: clampChatOrg(o.chatOrg),
    hideDeleteChatConfirm: bool(o.hideDeleteChatConfirm, d.hideDeleteChatConfirm),
  };
}

/** Merge a one-level-deep patch over a valid document, re-clamping the result. */
export function mergeSettingsPatch(
  current: DesktopSettings,
  patch: DesktopSettingsPatch,
): DesktopSettings {
  return clampSettings({
    ...current,
    ...patch,
    theme: { ...current.theme, ...patch.theme },
    search: { ...current.search, ...patch.search },
    capabilities: { ...current.capabilities, ...patch.capabilities },
    // Deep-merge the two advanced groups so a patch touching one sampling field
    // doesn't wipe the rest (the panel read-modify-writes the whole group, but a
    // narrower patch stays safe).
    advanced: {
      sampling: { ...current.advanced.sampling, ...patch.advanced?.sampling },
      reasoning: { ...current.advanced.reasoning, ...patch.advanced?.reasoning },
    },
  });
}

/**
 * Build the initial document when no settings.json exists yet, carrying the
 * onboarding choices forward so the two stay coherent (theme, starting
 * permission mode, generation capabilities). `mcpMode` comes from the existing
 * mcp-lite registry when present so an imported connector setup is respected.
 */
export function seedFromOnboarding(
  choices: OnboardingChoices | null,
  mcpMode: McpMode | null,
): DesktopSettings {
  if (choices === null) {
    return mcpMode === null ? DEFAULT_SETTINGS : { ...DEFAULT_SETTINGS, mcpMode };
  }
  return clampSettings({
    ...DEFAULT_SETTINGS,
    theme: { flavor: choices.theme.flavor, mode: choices.theme.mode },
    permissionMode: choices.permissionMode,
    capabilities: choices.capabilities,
    ...(mcpMode === null ? {} : { mcpMode }),
  });
}
