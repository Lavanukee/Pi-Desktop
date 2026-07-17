/**
 * Renderer settings state: mirrors `~/.pi/desktop/settings.json` (loaded via
 * settings:get), drives the live theme (resolving `system` → light/dark from the
 * OS preference), and on every change persists via settings:set + pushes the
 * side effects the frozen extensions observe:
 *   - theme  → the theme store (data-flavor/data-mode on <html>)
 *   - permission/effort → the harness, via `/harness` slash commands (the only
 *     runtime config path the frozen harness exposes)
 *   - search keys / mcp mode → handled main-side by settings:set
 */
import { create } from 'zustand';
import type {
  DesktopSettings,
  DesktopSettingsPatch,
  EffortLevel,
  EffortMode,
  EnginePreference,
  ModelSelection,
  ThemeModePref,
  UserMode,
} from '../../electron/settings/settings-contract';
import { type ThemeFlavor, useThemeStore } from '../store/theme';
import { applyHarnessConfig } from './pi-connect';

const ICON_STROKE_DEFAULT = 1.25;

const DEFAULTS: DesktopSettings = {
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
  sidebarScale: 1.0,
  menuScale: 1.0,
  favoriteModels: [],
  modelEffortDefaults: {},
  hfToken: '',
  experimentalProductionHarness: false,
};

function prefersDark(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

function resolveMode(mode: ThemeModePref): 'dark' | 'light' {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light';
  return mode;
}

/** Push the settings theme into the live theme store (which only knows light/dark). */
function applyTheme(settings: DesktopSettings): void {
  const theme = useThemeStore.getState();
  theme.setFlavor(settings.theme.flavor);
  theme.setMode(resolveMode(settings.theme.mode));
}

/** Drive the global icon stroke: an inline `--pd-icon-stroke` on the document
 * root wins over the theme token, thinning/thickening every `.pd-icon` glyph. */
function applyIconStroke(value: number): void {
  document.documentElement.style.setProperty('--pd-icon-stroke', String(value));
}

/** Drive the element-size scales: inline `--pd-sidebar-scale` / `--pd-menu-scale`
 * on the document root inherit down and multiply the tokenized `calc()` metrics
 * (sidebar rows + rail; the shared `.pd-menu` option rows). Default 1.0 = no-op.
 * A blanket set is idempotent, so no per-field guard is needed at the call site. */
function applyUiScales(s: DesktopSettings): void {
  const root = document.documentElement.style;
  root.setProperty('--pd-sidebar-scale', String(s.sidebarScale));
  root.setProperty('--pd-menu-scale', String(s.menuScale));
}

interface SettingsStoreState {
  settings: DesktopSettings;
  loaded: boolean;
  load: () => Promise<void>;
  /** Merge a patch, persist, apply theme + harness side effects. */
  update: (patch: DesktopSettingsPatch) => Promise<void>;
  /** Top-bar quick toggle: apply a concrete flavor/mode to the live theme store
   * and persist it, so the flip is instant AND survives a reload. */
  setTheme: (patch: { flavor?: ThemeFlavor; mode?: 'dark' | 'light' }) => Promise<void>;
}

export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  settings: DEFAULTS,
  loaded: false,

  // Fetch settings into the store WITHOUT applying the theme — connectSettings
  // decides whether to apply it at boot (it deliberately doesn't under E2E, so
  // the base theme probe keeps the index.html default until it toggles).
  load: async () => {
    const settings = await window.piDesktop.invoke('settings:get', undefined);
    set({ settings, loaded: true });
  },

  update: async (patch) => {
    // Optimistic: apply theme immediately so the flip feels instant.
    const optimistic = {
      ...get().settings,
      ...patch,
      theme: { ...get().settings.theme, ...patch.theme },
      search: { ...get().settings.search, ...patch.search },
      capabilities: { ...get().settings.capabilities, ...patch.capabilities },
    };
    set({ settings: optimistic });
    if (patch.theme !== undefined) applyTheme(optimistic);
    if (patch.iconStroke !== undefined) applyIconStroke(optimistic.iconStroke);
    applyUiScales(optimistic);

    const settings = await window.piDesktop.invoke('settings:set', { patch });
    set({ settings });
    applyTheme(settings);
    applyIconStroke(settings.iconStroke);
    applyUiScales(settings);

    // Harness picks up permission/effort only via its slash commands — fire the
    // ones that actually changed (best-effort; a no-pi session just no-ops).
    const harness: Parameters<typeof applyHarnessConfig>[0] = {};
    if (patch.permissionMode !== undefined) harness.permissionMode = settings.permissionMode;
    if (patch.effort !== undefined) harness.effort = settings.effort;
    if (harness.permissionMode !== undefined || harness.effort !== undefined) {
      void applyHarnessConfig(harness);
    }
  },

  setTheme: async (patch) => {
    // A top-bar toggle is an explicit, concrete choice, so — unlike update() —
    // apply it to the live theme store verbatim (no `system` re-resolution, which
    // would fight the toggle) and persist the concrete value so it sticks across
    // a reload. Keep the in-memory settings in sync so the Appearance panel agrees.
    const theme = useThemeStore.getState();
    if (patch.flavor !== undefined) theme.setFlavor(patch.flavor);
    if (patch.mode !== undefined) theme.setMode(patch.mode);
    set({ settings: { ...get().settings, theme: { ...get().settings.theme, ...patch } } });
    const settings = await window.piDesktop.invoke('settings:set', { patch: { theme: patch } });
    set({ settings });
  },
}));

/**
 * userMode API (round-12 #4). The single source of truth for the app's
 * experience level, persisted to settings.json and read by the model-dropdown
 * / model-manager waves (W3/W4) to decide whether to surface friendly tiers
 * (`user`) or real model names (`power`).
 *
 *   - `selectUserMode` — a plain selector for `useSettingsStore(selectUserMode)`
 *     (reactive) or `selectUserMode(useSettingsStore.getState())` (imperative).
 *   - `useUserMode`     — the ready-made reactive hook.
 *   - `setUserMode`     — persist a new mode (via settings:set) + update state.
 */
export const selectUserMode = (state: SettingsStoreState): UserMode => state.settings.userMode;

/** Reactive hook: the current experience level. */
export function useUserMode(): UserMode {
  return useSettingsStore(selectUserMode);
}

/** Persist the experience level (no-op re-write is harmless). */
export async function setUserMode(userMode: UserMode): Promise<void> {
  await useSettingsStore.getState().update({ userMode });
}

/**
 * enginePreference API (round-12 #4 — the Model Manager's "Prefer MLX
 * (experimental)" toggle). Follows the userMode pattern: a plain selector, a
 * ready-made reactive hook, and a persist setter. `mlx` opts into the (later-wave)
 * Apple-Silicon MLX backend; the toggle here persists the preference + drives the
 * engine badge/note, without changing any launch path yet.
 */
export const selectEnginePreference = (state: SettingsStoreState): EnginePreference =>
  state.settings.enginePreference;

/** Reactive hook: the preferred local inference engine. */
export function useEnginePreference(): EnginePreference {
  return useSettingsStore(selectEnginePreference);
}

/** Persist the engine preference (no-op re-write is harmless). */
export async function setEnginePreference(enginePreference: EnginePreference): Promise<void> {
  await useSettingsStore.getState().update({ enginePreference });
}

/**
 * modelSelection + effortMode API (round-12). Shared by W2 (composer-bar effort
 * slider + tier display) and W3 (footer dropdown + Auto router) — both setters
 * live here so neither wave has to edit this store file.
 */
export const selectModelSelection = (state: SettingsStoreState): ModelSelection =>
  state.settings.modelSelection;
export const selectEffortMode = (state: SettingsStoreState): EffortMode =>
  state.settings.effortMode;

/** Reactive hook: the current model selection (auto / a tier / an explicit model). */
export function useModelSelection(): ModelSelection {
  return useSettingsStore(selectModelSelection);
}

/** Reactive hook: the current effort mode ('auto' or an explicit level). */
export function useEffortMode(): EffortMode {
  return useSettingsStore(selectEffortMode);
}

/** Persist the model selection. */
export async function setModelSelection(modelSelection: ModelSelection): Promise<void> {
  await useSettingsStore.getState().update({ modelSelection });
}

/** Persist the effort mode. */
export async function setEffortMode(effortMode: EffortMode): Promise<void> {
  await useSettingsStore.getState().update({ effortMode });
}

/**
 * Re-push the saved permission-mode / effort into a freshly (re)started pi
 * session. Only the values that DIFFER from the harness's own defaults
 * (`reviewer` / `medium`) are sent, so a default profile issues no commands —
 * which keeps a fresh session's thread clean (each command is a real pi turn).
 */
export function applySavedHarnessConfig(): void {
  const { permissionMode, effort } = useSettingsStore.getState().settings;
  const patch: Parameters<typeof applyHarnessConfig>[0] = {};
  if (permissionMode !== 'reviewer') patch.permissionMode = permissionMode;
  if (effort !== 'medium') patch.effort = effort;
  if (patch.permissionMode !== undefined || patch.effort !== undefined) {
    void applyHarnessConfig(patch);
  }
}

/**
 * Experimental production-harness flag (default FALSE). The single gate for ALL
 * corp wiring: when this returns false the app is byte-for-byte its current self
 * (normal solo pi chat). Follows the userMode API pattern — a plain selector, a
 * reactive hook, and a persist setter.
 */
export const selectExperimentalProductionHarness = (state: SettingsStoreState): boolean =>
  state.settings.experimentalProductionHarness;

/** Reactive hook: the persisted experimental production-harness setting. */
export function useExperimentalProductionHarness(): boolean {
  return useSettingsStore(selectExperimentalProductionHarness);
}

/** Persist the experimental production-harness flag. */
export async function setExperimentalProductionHarness(enabled: boolean): Promise<void> {
  await useSettingsStore.getState().update({ experimentalProductionHarness: enabled });
}

/**
 * The DEV env override (`PI_DESKTOP_CORP=1`), surfaced by main.ts as a `?corp=1`
 * query param on the main window. Resolved lazily + cached (a launch-time flag),
 * and guarded so importing this module in a non-DOM (test) context is safe.
 */
let corpEnvOverride: boolean | undefined;
function corpEnvOverrideEnabled(): boolean {
  if (corpEnvOverride === undefined) {
    corpEnvOverride =
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('corp');
  }
  return corpEnvOverride;
}

/**
 * The EFFECTIVE production-harness state: the persisted setting OR the dev env
 * override. This is the value the chat trigger consults to decide whether a
 * submitted prompt drives the CorpEngine instead of the normal pi turn. Imperative
 * (reads the current store state) so a submit handler can call it inline.
 */
export function productionHarnessEnabled(): boolean {
  return (
    corpEnvOverrideEnabled() || useSettingsStore.getState().settings.experimentalProductionHarness
  );
}

/** Star / unstar a model id, persisting the whole favorites list. */
export async function toggleFavoriteModel(modelId: string): Promise<void> {
  const current = useSettingsStore.getState().settings.favoriteModels;
  const favoriteModels = current.includes(modelId)
    ? current.filter((id) => id !== modelId)
    : [...current, modelId];
  await useSettingsStore.getState().update({ favoriteModels });
}

/**
 * Set (or clear, when `effort` is undefined) a model's default effort, persisting
 * the whole map. Applies immediately only when the model is already active — the
 * usual path is {@link applyModelEffortDefault} at set-active time.
 */
export async function setModelEffortDefault(
  modelId: string,
  effort: EffortLevel | undefined,
): Promise<void> {
  const current = { ...useSettingsStore.getState().settings.modelEffortDefaults };
  if (effort === undefined) delete current[modelId];
  else current[modelId] = effort;
  await useSettingsStore.getState().update({ modelEffortDefaults: current });
}

/**
 * When a model with a stored effort default becomes active, push that effort
 * into the settings (which drives the harness `/harness effort` command). A
 * no-op when the model has no default or already matches the current effort.
 */
export async function applyModelEffortDefault(modelId: string): Promise<void> {
  const { modelEffortDefaults, effort } = useSettingsStore.getState().settings;
  const target = modelEffortDefaults[modelId];
  if (target !== undefined && target !== effort) {
    await useSettingsStore.getState().update({ effort: target });
  }
}

let connected = false;

/** Load settings + keep the theme following the OS when mode is `system`. */
export function connectSettings(): void {
  if (connected) return;
  connected = true;

  // Under E2E the base theme probe asserts the exact index.html default
  // (claude/dark) and drives the flavor/mode toggles itself, so we must not
  // apply a persisted/seeded theme at boot. Live changes via update() still
  // apply — only this boot-time application is suppressed.
  const isE2E = new URLSearchParams(window.location.search).has('piE2E');

  void useSettingsStore
    .getState()
    .load()
    .then(() => {
      const { settings } = useSettingsStore.getState();
      if (!isE2E) applyTheme(settings);
      // Icon stroke is orthogonal to the theme probes (a unitless override that
      // matches the token at its default), so it is safe to apply at boot even
      // under E2E — this is what makes a persisted thickness survive a reload.
      applyIconStroke(settings.iconStroke);
      // Element-size scales are unitless multipliers on tokenized calc()s
      // (default 1.0 = no-op), orthogonal to the theme probes for the same
      // reason — apply at boot so persisted scales survive a reload.
      applyUiScales(settings);
    });

  if (typeof window.matchMedia === 'function') {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener('change', () => {
      const { settings } = useSettingsStore.getState();
      if (!isE2E && settings.theme.mode === 'system') applyTheme(settings);
    });
  }

  // E2E: expose a read handle behind the same opt-in as __pi_store (main appends
  // ?piE2E=1 under PI_E2E). Same-context code can reach the store anyway; gating
  // just keeps production from shipping a stable settings handle on window.
  if (isE2E) {
    window.__settings_store = () => useSettingsStore;
  }
}
