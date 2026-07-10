/**
 * @pi-desktop/themes — semantic design-token vocabulary and the four
 * claude/codex x light/dark theme definitions, plus the CSS emitter that
 * produces src/generated/themes.css (import it as
 * `@pi-desktop/themes/themes.css`).
 */
export { colorTokenNames, emitThemesCss, flattenTheme } from './emit.ts';
export type {
  StatusKind,
  StatusTokens,
  ThemeFlavor,
  ThemeId,
  ThemeMode,
  ThemeTokens,
  TypeScaleSlot,
} from './tokens.ts';
export { parseThemeId, themeIds, themes } from './tokens.ts';
