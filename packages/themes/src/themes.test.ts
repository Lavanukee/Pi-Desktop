import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { colorTokenNames, emitThemesCss, flattenTheme } from './emit.ts';
import { parseThemeId, themeIds, themes } from './tokens.ts';

const HEX_COLOR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/;

describe('theme vocabulary', () => {
  it('defines the exact same set of --pd-* names in all 4 combos', () => {
    const reference = flattenTheme(themes['claude-light']).map(([name]) => name);
    expect(reference.length).toBeGreaterThan(80);
    expect(new Set(reference).size).toBe(reference.length); // no duplicates
    for (const id of themeIds) {
      const names = flattenTheme(themes[id]).map(([name]) => name);
      expect(names, `token names of ${id}`).toEqual(reference);
    }
  });

  it('has a parseable concrete color for every color slot in every theme', () => {
    const colorNames = new Set(colorTokenNames());
    expect(colorNames.size).toBeGreaterThan(30);
    for (const id of themeIds) {
      for (const [name, value] of flattenTheme(themes[id])) {
        if (!colorNames.has(name)) continue;
        expect(value, `${id} ${name}`).toMatch(HEX_COLOR);
      }
    }
  });

  it('uses only px/percent lengths for radius, spacing and control tokens', () => {
    for (const id of themeIds) {
      for (const [name, value] of flattenTheme(themes[id])) {
        // --pd-icon-stroke is a unitless SVG stroke-width, not a length.
        if (name === '--pd-icon-stroke') continue;
        if (/^--pd-(radius|space|control|font-size|leading|icon)/.test(name)) {
          expect(value, `${id} ${name}`).toMatch(/^\d+(\.\d+)?px$/);
        }
        if (/^--pd-duration/.test(name)) {
          expect(value, `${id} ${name}`).toMatch(/^\d+ms$/);
        }
      }
    }
  });

  it('exposes a unitless --pd-icon-stroke in every theme', () => {
    for (const id of themeIds) {
      const stroke = flattenTheme(themes[id]).find(([name]) => name === '--pd-icon-stroke');
      expect(stroke, `${id} has --pd-icon-stroke`).toBeDefined();
      expect(stroke?.[1], `${id} --pd-icon-stroke`).toMatch(/^\d+(\.\d+)?$/);
    }
  });

  it('preserves the flavor signatures from the harvest', () => {
    expect(themes['claude-light'].accent.primary).toBe('#d97757');
    expect(themes['claude-dark'].accent.primary).toBe('#d97757');
    expect(themes['codex-light'].font.weight.body).toBe('430');
    expect(themes['codex-light'].motion.shimmerEasing).toBe('steps(48, end)');
    expect(themes['claude-light'].motion.pressScale).toBe('0.98');
    expect(themes['codex-light'].motion.pressScale).toBe('1');
    expect(themes['codex-light'].motion.easing.enter).toBe('cubic-bezier(0.19, 1, 0.22, 1)');
    expect(themes['claude-light'].motion.easing.press).toBe('cubic-bezier(0.165, 0.85, 0.45, 1)');
  });
});

describe('generated CSS', () => {
  const generatedPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'generated/themes.css',
  );

  it('is in sync with tokens.ts (regenerate-and-diff)', () => {
    const emitted = emitThemesCss();
    const committed = readFileSync(generatedPath, 'utf8');
    expect(committed).toBe(emitted);
  });

  it('contains all four attribute scopes and the shared keyframes', () => {
    const css = emitThemesCss();
    for (const flavor of ['claude', 'codex'] as const) {
      for (const mode of ['light', 'dark'] as const) {
        expect(css).toContain(`:root[data-flavor='${flavor}'][data-mode='${mode}']`);
      }
    }
    for (const kf of [
      'pd-shimmer-sweep',
      'pd-shimmer-highlight',
      'pd-fade-in',
      'pd-pop-in',
      'pd-press-settle',
      'pd-spin',
      'pd-slide-bar',
    ]) {
      expect(css).toContain(`@keyframes ${kf}`);
    }
    expect(css).toContain("@import '@fontsource-variable/inter'");
    expect(css).toContain("@import '@fontsource-variable/source-serif-4'");
  });

  it('emits codex squircle radii overrides that actually win the cascade', () => {
    const css = emitThemesCss();
    const supportsStart = css.indexOf('@supports (corner-shape: superellipse(1.5)) {');
    expect(supportsStart).toBeGreaterThan(-1);
    // A bare-flavor selector is (0,2,0) and loses to the (0,3,0) base blocks
    // no matter where it appears — the override must be mode-qualified.
    expect(css).not.toContain(":root[data-flavor='codex'] {");
    const block = css.slice(supportsStart, css.indexOf('\n}', supportsStart));
    for (const mode of ['light', 'dark'] as const) {
      const selector = `:root[data-flavor='codex'][data-mode='${mode}'] {`;
      expect(block, `squircle override for codex-${mode}`).toContain(selector);
      // Equal specificity + later source order = the override wins.
      expect(css.indexOf(selector)).toBeLessThan(supportsStart);
    }
    // Radii are scaled 1.25x (codex base --pd-radius-md is 8px)...
    expect(block).toContain('--pd-radius-md: 10px;');
    // ...but the 9999px pill radius is left alone.
    expect(block).not.toContain('--pd-radius-full');
  });

  it('emits a reduced-motion duration override that wins over every theme block', () => {
    const css = emitThemesCss();
    const mediaStart = css.indexOf('@media (prefers-reduced-motion: reduce) {');
    expect(mediaStart).toBeGreaterThan(-1);
    const block = css.slice(mediaStart, css.indexOf('\n}', mediaStart));
    // (0,3,0) selector ties every base theme block; later source order wins.
    expect(block).toContain(':root[data-flavor][data-mode] {');
    for (const slot of ['fast', 'base', 'slow'] as const) {
      // 0.01ms (not 0ms) so animationend/transitionend still fire.
      expect(block).toContain(`--pd-duration-${slot}: 0.01ms;`);
    }
    for (const id of themeIds) {
      const { flavor, mode } = parseThemeId(id);
      const selector = `:root[data-flavor='${flavor}'][data-mode='${mode}'] {`;
      expect(css.indexOf(selector), `${id} block before reduce block`).toBeLessThan(mediaStart);
    }
    // Shimmer stays token-driven: near-zero infinite animations strobe, so
    // component CSS disables shimmer under `reduce` instead.
    expect(block).not.toContain('--pd-shimmer-duration');
  });
});
