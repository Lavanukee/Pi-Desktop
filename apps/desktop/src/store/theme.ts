import { create } from 'zustand';

export type ThemeFlavor = 'claude' | 'codex';
export type ThemeMode = 'dark' | 'light';

export interface ThemeState {
  flavor: ThemeFlavor;
  mode: ThemeMode;
  setFlavor(flavor: ThemeFlavor): void;
  setMode(mode: ThemeMode): void;
  toggleFlavor(): void;
  toggleMode(): void;
}

// Defaults must match the attributes pre-set on <html> in index.html.
export const useThemeStore = create<ThemeState>()((set) => ({
  flavor: 'claude',
  mode: 'dark',
  setFlavor: (flavor) => set({ flavor }),
  setMode: (mode) => set({ mode }),
  toggleFlavor: () => set((s) => ({ flavor: s.flavor === 'claude' ? 'codex' : 'claude' })),
  toggleMode: () => set((s) => ({ mode: s.mode === 'dark' ? 'light' : 'dark' })),
}));

export interface ThemeAttributeTarget {
  setAttribute(name: string, value: string): void;
}

/**
 * Writes the attribute pair that drives all `--pd-*` token resolution
 * (see src/styles/tokens-placeholder.css). Applied to <html>.
 */
export function applyThemeAttributes(
  target: ThemeAttributeTarget,
  theme: { flavor: ThemeFlavor; mode: ThemeMode },
): void {
  target.setAttribute('data-flavor', theme.flavor);
  target.setAttribute('data-mode', theme.mode);
}
