/**
 * Pure onboarding mappings — kept separate from React so the auto-theme and
 * experience-gauge rules are unit-testable and can't drift silently.
 */
import type { ClaudeThemeMode } from '@pi-desktop/importers';
import type {
  GenerationCapabilities,
  OnboardingChoices,
} from '../../electron/import/import-contract';
import type { ThemeFlavor, ThemeMode } from '../store/theme';

export type SourceChoice = 'claude' | 'codex' | 'neither';
export type ExperienceLevel = 'new' | 'knows-llamacpp' | 'no-tutorial';

/** Auto-pick the UI flavor from the source app (swappable on the theme step).
 * Users coming from neither app get Bobble — the app's own identity. */
export function flavorForSource(source: SourceChoice): ThemeFlavor {
  if (source === 'codex') return 'codex';
  if (source === 'claude') return 'claude';
  return 'bobble';
}

/**
 * Claude's `userThemeMode` → our two-value mode. `system`/absent resolves via
 * the OS preference (Codex ships no light/dark setting, so it lands here too).
 */
export function resolveMode(themeMode: ClaudeThemeMode | null, prefersDark: boolean): ThemeMode {
  if (themeMode === 'light') return 'light';
  if (themeMode === 'dark') return 'dark';
  return prefersDark ? 'dark' : 'light';
}

export interface ExperienceMapping {
  tutorial: boolean;
  permissionMode: OnboardingChoices['permissionMode'];
}

/**
 * Experience gauge → tutorial flag + starting permission mode. Newer users get
 * the guided tutorial and the safest (review-all) permissions; power users opt
 * into faster, looser modes.
 */
export function mapExperience(level: ExperienceLevel): ExperienceMapping {
  switch (level) {
    case 'new':
      return { tutorial: true, permissionMode: 'review-all' };
    case 'knows-llamacpp':
      return { tutorial: false, permissionMode: 'reviewer' };
    case 'no-tutorial':
      return { tutorial: false, permissionMode: 'bypass' };
  }
}

export const DEFAULT_CAPABILITIES: GenerationCapabilities = {
  image: false,
  video: false,
  audio: false,
  threeD: false,
};

/** Preselect the source app that has config on disk (Claude wins a tie). */
export function preselectSource(detected: { claude: boolean; codex: boolean }): SourceChoice {
  if (detected.claude) return 'claude';
  if (detected.codex) return 'codex';
  return 'neither';
}
