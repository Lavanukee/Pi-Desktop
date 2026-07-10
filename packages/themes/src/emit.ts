/**
 * Build-time emitter: turns the typed theme definitions into the checked-in
 * `src/generated/themes.css`. Deterministic — the unit test regenerates and
 * diffs against the committed file.
 */

import type { ThemeTokens } from './tokens.ts';
import { parseThemeId, themeIds, themes } from './tokens.ts';

/** Flattens a theme into ordered `--pd-*` custom-property pairs. */
export function flattenTheme(t: ThemeTokens): Array<[name: string, value: string]> {
  const out: Array<[string, string]> = [];
  const push = (name: string, value: string) => {
    out.push([`--pd-${name}`, value]);
  };

  push('bg-base', t.bg.base);
  push('bg-raised', t.bg.raised);
  push('bg-overlay', t.bg.overlay);
  push('bg-inset', t.bg.inset);
  push('bg-hover', t.bg.hover);
  push('bg-active', t.bg.active);
  push('bg-backdrop', t.bg.backdrop);
  push('bg-sidebar', t.bg.sidebar);
  push('bg-selected', t.bg.selected);
  push('bg-track', t.bg.track);

  push('text-primary', t.text.primary);
  push('text-secondary', t.text.secondary);
  push('text-muted', t.text.muted);
  push('text-inverse', t.text.inverse);
  push('text-on-accent', t.text.onAccent);
  push('text-link', t.text.link);
  push('text-placeholder', t.text.placeholder);
  push('text-ghost', t.text.ghost);

  push('border-subtle', t.border.subtle);
  push('border-default', t.border.default);
  push('border-strong', t.border.strong);
  push('border-focus', t.border.focus);

  push('accent-primary', t.accent.primary);
  push('accent-hover', t.accent.hover);
  push('accent-active', t.accent.active);
  push('accent-subtle', t.accent.subtle);

  for (const kind of ['info', 'success', 'warning', 'danger'] as const) {
    push(`status-${kind}-bg`, t.status[kind].bg);
    push(`status-${kind}-fg`, t.status[kind].fg);
    push(`status-${kind}-border`, t.status[kind].border);
  }

  push('user-bubble-bg', t.bubble.bg);
  push('user-bubble-fg', t.bubble.fg);

  push('tooltip-bg', t.tooltip.bg);
  push('tooltip-fg', t.tooltip.fg);

  push('inline-code-bg', t.codeSurface.inlineBg);
  push('inline-code-fg', t.codeSurface.inlineFg);
  push('inline-code-border', t.codeSurface.inlineBorder);
  push('code-block-bg', t.codeSurface.blockBg);
  push('code-block-border', t.codeSurface.blockBorder);

  push('diff-added-fg', t.diff.addedFg);
  push('diff-deleted-fg', t.diff.deletedFg);
  push('diff-modified-fg', t.diff.modifiedFg);

  push('scrollbar-thumb', t.scrollbar.thumb);
  push('scrollbar-thumb-hover', t.scrollbar.thumbHover);

  push('sidebar-border', t.sidebar.border);
  push('sidebar-shadow', t.sidebar.shadow);
  push('sidebar-translucency', t.sidebar.translucency);
  push('sidebar-blur', t.sidebar.blur);

  push('shimmer-base', t.shimmer.base);
  push('shimmer-highlight', t.shimmer.highlight);

  push('font-sans', t.font.sans);
  push('font-serif', t.font.serif);
  push('font-mono', t.font.mono);
  for (const slot of ['caption', 'footnote', 'body', 'code', 'heading', 'title'] as const) {
    push(`font-size-${slot}`, t.font.size[slot]);
    push(`leading-${slot}`, t.font.leading[slot]);
  }
  push('font-weight-regular', t.font.weight.regular);
  push('font-weight-medium', t.font.weight.medium);
  push('font-weight-semibold', t.font.weight.semibold);
  push('font-weight-bold', t.font.weight.bold);
  push('font-weight-body', t.font.weight.body);
  push('font-response-family', t.font.response.family);
  push('font-response-size', t.font.response.size);
  push('leading-response', t.font.response.leading);
  push('font-response-variation', t.font.response.variation);

  push('radius-xs', t.radius.xs);
  push('radius-sm', t.radius.sm);
  push('radius-md', t.radius.md);
  push('radius-lg', t.radius.lg);
  push('radius-full', t.radius.full);
  push('radius-surface', t.radius.surface);
  push('radius-popover', t.radius.popover);
  push('radius-row', t.radius.row);
  push('radius-bubble', t.radius.bubble);
  push('radius-button', t.radius.button);
  push('radius-menu-item', t.radius.menuItem);

  push('shadow-sm', t.shadow.sm);
  push('shadow-md', t.shadow.md);
  push('shadow-lg', t.shadow.lg);
  push('shadow-popover', t.shadow.popover);
  push('shadow-hairline', t.shadow.hairline);

  push('surface-translucency', t.surface.translucency);
  push('blur-overlay', t.surface.blurOverlay);
  push('blur-backdrop', t.surface.blurBackdrop);

  push('duration-fast', t.motion.duration.fast);
  push('duration-base', t.motion.duration.base);
  push('duration-slow', t.motion.duration.slow);
  push('duration-dialog-in', t.motion.duration.dialogIn);
  push('duration-dialog-out', t.motion.duration.dialogOut);
  push('duration-menu', t.motion.duration.menu);
  push('duration-toast', t.motion.duration.toast);
  push('easing-standard', t.motion.easing.standard);
  push('easing-enter', t.motion.easing.enter);
  push('easing-exit', t.motion.easing.exit);
  push('easing-press', t.motion.easing.press);
  push('easing-spring', t.motion.easing.spring);
  push('easing-toast', t.motion.easing.toast);
  push('press-scale', t.motion.pressScale);
  push('press-scale-small', t.motion.pressScaleSmall);
  push('shimmer-duration', t.motion.shimmerDuration);
  push('shimmer-easing', t.motion.shimmerEasing);
  push('menu-enter-distance', t.motion.menuEnterDistance);
  push('menu-enter-scale', t.motion.menuEnterScale);
  push('menu-stagger', t.motion.menuStagger);
  push('menu-item-resting-opacity', t.motion.menuItemRestingOpacity);
  push('dialog-enter-scale', t.motion.dialogEnterScale);
  push('dialog-enter-translate', t.motion.dialogEnterTranslate);
  push('dialog-origin', t.motion.dialogOrigin);
  push('toast-enter-x', t.motion.toastEnterX);
  push('toast-enter-y', t.motion.toastEnterY);

  push('space-xs', t.spacing.xs);
  push('space-sm', t.spacing.sm);
  push('space-md', t.spacing.md);
  push('space-lg', t.spacing.lg);
  push('space-xl', t.spacing.xl);
  push('space-xxl', t.spacing.xxl);
  push('space-xxxl', t.spacing.xxxl);

  push('control-sm', t.control.sm);
  push('control-md', t.control.md);
  push('control-lg', t.control.lg);
  push('icon-size', t.control.icon);
  push('icon-stroke', t.control.iconStroke);

  push('row-height', t.layout.rowHeight);
  push('sidebar-width', t.layout.sidebarWidth);
  push('height-topbar', t.layout.topbarHeight);
  push('thread-width', t.layout.threadWidth);
  push('thread-prose-width', t.layout.proseWidth);
  push('thinking-preview-height', t.layout.thinkingPreviewHeight);
  push('menu-padding', t.layout.menuPadding);

  return out;
}

/** Token names whose values must parse as a single concrete color. */
export function colorTokenNames(): string[] {
  const sample = flattenTheme(themes['claude-light']);
  const colorPrefixes = [
    '--pd-bg-',
    '--pd-text-',
    '--pd-border-',
    '--pd-accent-',
    '--pd-status-',
    '--pd-user-bubble-',
    '--pd-tooltip-',
    '--pd-inline-code-',
    '--pd-code-block-',
    '--pd-diff-',
    '--pd-scrollbar-',
    '--pd-shimmer-base',
    '--pd-shimmer-highlight',
  ];
  return sample
    .map(([name]) => name)
    .filter((name) => colorPrefixes.some((p) => name.startsWith(p)));
}

const SQUIRCLE_SCALE = 1.25;

function scaledRadius(value: string): string {
  const px = Number.parseFloat(value);
  if (!Number.isFinite(px) || !value.endsWith('px') || px >= 9999) return value;
  const scaled = px * SQUIRCLE_SCALE;
  return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}px`;
}

const KEYFRAMES = `/* Shared animation keyframes. Flavor timing/easing comes from tokens:
 * animation: pd-shimmer-sweep var(--pd-shimmer-duration) var(--pd-shimmer-easing) infinite; */

/* Thinking shimmer: masked 50%-width sweep with counter-translating highlight. */
@keyframes pd-shimmer-sweep {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(250%); }
}
@keyframes pd-shimmer-highlight {
  0% { transform: translateX(50%); }
  100% { transform: translateX(-125%); }
}
/* Generic background-position shimmer for skeletons. */
@keyframes pd-shimmer-bg {
  0% { background-position: -100% 0; }
  100% { background-position: 250% 0; }
}

@keyframes pd-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes pd-fade-out {
  from { opacity: 1; }
  to { opacity: 0; }
}

/* Popover/dialog entrances: codex dialog translateY(8px) scale(.98) -> rest. */
@keyframes pd-pop-in {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes pd-pop-out {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to { opacity: 0; transform: translateY(8px) scale(0.98); }
}
/* Claude modal zoom. */
@keyframes pd-zoom-in {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes pd-zoom-out {
  from { opacity: 1; transform: scale(1); }
  to { opacity: 0; transform: scale(0.96); }
}

/* Toast entrance (codex toast-open). */
@keyframes pd-slide-down-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes pd-slide-up-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Press/settle: quick dip to press-scale, settle back. */
@keyframes pd-press-settle {
  0% { transform: scale(1); }
  35% { transform: scale(var(--pd-press-scale, 0.98)); }
  100% { transform: scale(1); }
}

@keyframes pd-spin {
  to { transform: rotate(360deg); }
}
@keyframes pd-pulse {
  50% { opacity: 0.5; }
}
/* Indeterminate progress bar sweep. */
@keyframes pd-slide-bar {
  from { transform: translateX(-100%); }
  to { transform: translateX(350%); }
}`;

/**
 * Reduced-motion override. Durations collapse to 0.01ms (not 0ms) so
 * animationend/transitionend still fire and exit-animation-gated unmounts
 * (dialogs, toasts) do not hang. The selector ties the base theme blocks'
 * (0,3,0) specificity, and the block is emitted after them, so it wins for
 * every flavor/mode.
 *
 * Infinite animations are exempt from the duration collapse — a near-zero
 * infinite animation strobes — so --pd-shimmer-duration is left alone.
 * Convention for component CSS built on this vocabulary:
 * - pd-shimmer-*, pd-slide-bar, pd-pulse: set `animation: none` under the
 *   same media query;
 * - pd-spin may keep running (loading-progress feedback is essential motion
 *   under WCAG 2.3.3).
 */
const REDUCED_MOTION = `/* Reduced motion: collapse transition/animation durations to near-zero.
 * Infinite animations (pd-shimmer-*, pd-slide-bar, pd-pulse) are exempt and
 * must be disabled by component CSS under this same media query; pd-spin may
 * keep running as essential loading feedback. */
@media (prefers-reduced-motion: reduce) {
  :root[data-flavor][data-mode] {
    --pd-duration-fast: 0.01ms;
    --pd-duration-base: 0.01ms;
    --pd-duration-slow: 0.01ms;
    --pd-duration-dialog-in: 0.01ms;
    --pd-duration-dialog-out: 0.01ms;
    --pd-duration-menu: 0.01ms;
    --pd-duration-toast: 0.01ms;
    --pd-menu-stagger: 0ms;
  }
}`;

export function emitThemesCss(): string {
  const lines: string[] = [];
  lines.push('/* biome-ignore-all format: generated file */');
  lines.push('/* biome-ignore-all lint: generated file */');
  lines.push('/*');
  lines.push(' * GENERATED FILE — DO NOT EDIT.');
  lines.push(' * Source of truth: packages/themes/src/tokens.ts');
  lines.push(' * Regenerate with: pnpm --filter @pi-desktop/themes generate');
  lines.push(' */');
  lines.push('');
  lines.push('/* Open-licensed (OFL) fonts for the claude flavor, via fontsource. */');
  lines.push("@import '@fontsource-variable/inter';");
  lines.push("@import '@fontsource-variable/source-serif-4';");
  lines.push('');

  for (const id of themeIds) {
    const { flavor, mode } = parseThemeId(id);
    lines.push(`:root[data-flavor='${flavor}'][data-mode='${mode}'] {`);
    lines.push(`  color-scheme: ${mode};`);
    for (const [name, value] of flattenTheme(themes[id])) {
      lines.push(`  ${name}: ${value};`);
    }
    lines.push('}');
    lines.push('');
  }

  // Codex squircle signature: radii scale by 1.25 when superellipse corners
  // are supported. Selectors are mode-qualified to tie the base blocks'
  // (0,3,0) specificity so source order makes the override win — a bare
  // [data-flavor='codex'] rule is (0,2,0) and always loses. Rounded
  // primitives must pair this with `corner-shape: superellipse(1.5)` under
  // the same @supports, otherwise the scaled radii just yield larger
  // circular corners.
  lines.push('@supports (corner-shape: superellipse(1.5)) {');
  for (const id of themeIds) {
    const { flavor, mode } = parseThemeId(id);
    if (flavor !== 'codex') continue;
    lines.push(`  :root[data-flavor='${flavor}'][data-mode='${mode}'] {`);
    for (const [name, value] of flattenTheme(themes[id])) {
      if (!name.startsWith('--pd-radius-')) continue;
      const scaled = scaledRadius(value);
      if (scaled !== value) lines.push(`    ${name}: ${scaled};`);
    }
    lines.push('  }');
  }
  lines.push('}');
  lines.push('');
  lines.push(KEYFRAMES);
  lines.push('');
  lines.push(REDUCED_MOTION);
  lines.push('');

  return lines.join('\n');
}
