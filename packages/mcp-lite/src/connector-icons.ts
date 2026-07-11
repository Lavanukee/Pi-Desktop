/**
 * Self-contained inline SVG marks for the connector gallery.
 *
 * Brand glyphs are pulled DIRECTLY from the CC0/MIT `simple-icons` npm package
 * (https://simpleicons.org) as named imports — never hand-transcribed — so the
 * `d` path and canonical brand `hex` are always the upstream-correct values (no
 * transcription corruption, no wrong-identity grabs). The explicit
 * {@link BRAND_ICONS} `id → siX` map declares every id≠slug remap
 * (`postgres → siPostgresql`, `google-drive → siGoogledrive`, …) and lets the
 * bundler tree-shake `simple-icons` down to only the ~20 marks used here. Each is
 * rendered in its brand color via the icon's `.hex` (e.g. Blender #E87D0D, Docker
 * #2496ED, Spotify #1ED760). Every mark is fully INLINE — no remote URLs — so it
 * works under the app CSP and offline.
 *
 * THEME SAFETY: a near-black brand (GitHub #181717, Notion #000) is invisible on
 * a dark surface, so those marks fill with `var(--pd-connector-ink, <brand hex>)`
 * — the brand hex on light, but the box's ink (currentColor) on dark, where the
 * app defines `--pd-connector-ink` (see ConnectorIcon's CSS). The hex fallback
 * keeps the mark correct even with no app CSS (tests/offline). Neutral CATEGORY
 * fallbacks stay `stroke="currentColor"`.
 *
 * All third-party product names, logos, and brands are the property of their
 * respective owners; the marks are used here for identification only (see the
 * disclaimer on the connectors page). Where a brand has no published mark in the
 * set (Slack/Tableau were removed upstream, Chrome DevTools was never in it) or
 * its published mark renders illegibly (Unity's mark is pure white, which would
 * vanish on a light surface), the connector falls back to a neutral CATEGORY
 * glyph rather than shipping a missing/garbled/invisible mark (see
 * {@link NEUTRAL_ICON_SVGS}).
 */
import {
  type SimpleIcon,
  siBlender,
  siBrave,
  siDiscord,
  siDocker,
  siFigma,
  siGit,
  siGithub,
  siGmail,
  siGooglecalendar,
  siGoogledrive,
  siLinear,
  siNotion,
  siObsidian,
  siPostgresql,
  siPostman,
  siSentry,
  siSpotify,
  siSqlite,
  siXcode,
  siZoom,
} from 'simple-icons';

/**
 * Connector id → its `simple-icons` mark. Explicit named imports (not slug
 * lookups) so id≠slug remaps are declared here and tree-shaking keeps only the
 * marks we actually reference. A connector is only listed when the package ships
 * a legible mark for it; otherwise it gets a {@link NEUTRAL_ICON_SVGS} glyph:
 *   - Slack, Tableau, Chrome DevTools — no mark published in the set.
 *   - Unity — its published mark is pure white (#FFFFFF), invisible on light.
 */
const BRAND_ICONS: Record<string, SimpleIcon> = {
  git: siGit,
  github: siGithub,
  postgres: siPostgresql,
  sqlite: siSqlite,
  postman: siPostman,
  sentry: siSentry,
  xcode: siXcode,
  docker: siDocker,
  notion: siNotion,
  linear: siLinear,
  figma: siFigma,
  'google-drive': siGoogledrive,
  gmail: siGmail,
  'google-calendar': siGooglecalendar,
  obsidian: siObsidian,
  'brave-search': siBrave,
  blender: siBlender,
  spotify: siSpotify,
  discord: siDiscord,
  zoom: siZoom,
};

/** Below this WCAG relative luminance a brand hex reads as "near-black". */
const NEAR_BLACK_LUMINANCE = 0.08;

/** Linearize one 0–255 sRGB channel (WCAG relative-luminance transfer). */
function channelLinear(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 = black, 1 = white) of a `#rrggbb` hex. */
function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return 0.2126 * channelLinear(r) + 0.7152 * channelLinear(g) + 0.0722 * channelLinear(b);
}

/** A brand color so dark it would vanish on a dark surface (GitHub, Notion, …). */
function isNearBlackBrand(color: string): boolean {
  return color.startsWith('#') && relativeLuminance(color) < NEAR_BLACK_LUMINANCE;
}

/**
 * Wrap a single-path brand glyph as a self-contained inline SVG filled in its
 * brand color. Near-black brands flip to the box's ink (`--pd-connector-ink`,
 * set to currentColor by the app on dark surfaces) so they stay legible on
 * dark; the brand hex is the fallback so the mark is correct without app CSS.
 */
function brandSvg(pathD: string, color: string): string {
  const fill = isNearBlackBrand(color) ? `var(--pd-connector-ink, ${color})` : color;
  return (
    `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="${fill}" ` +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="${pathD}"/></svg>`
  );
}

/** Wrap neutral line-art shapes as a self-contained, monochrome stroked SVG. */
function neutralSvg(shapes: string): string {
  return (
    '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ' +
    `xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${shapes}</svg>`
  );
}

/**
 * Neutral CATEGORY glyphs for connectors that have no simple, published brand
 * mark (or whose mark is complex/proprietary/uncertain/illegible). Deliberately
 * generic line-art so they never misrepresent a brand.
 */
const NEUTRAL_ICON_SVGS: Record<string, string> = {
  // Folder.
  filesystem: neutralSvg(
    '<path d="M3.5 7.25a1.5 1.5 0 0 1 1.5-1.5h3.3l1.7 2h8.5a1.5 1.5 0 0 1 1.5 1.5v7.75a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  ),
  // Knowledge-graph nodes.
  memory: neutralSvg(
    '<circle cx="6" cy="7" r="2.15"/><circle cx="17.6" cy="7.5" r="2.15"/><circle cx="11.6" cy="17" r="2.15"/><path d="M8.13 7.2 15.47 7.4"/><path d="M7.06 8.86 10.55 15.15"/><path d="M16.55 9.28 12.62 15.2"/>',
  ),
  // Ordered/stepped list.
  'sequential-thinking': neutralSvg(
    '<circle cx="4.75" cy="7" r="1.1"/><circle cx="4.75" cy="12" r="1.1"/><circle cx="4.75" cy="17" r="1.1"/><path d="M8.5 7H20"/><path d="M8.5 12H20"/><path d="M8.5 17H16"/>',
  ),
  // Clock.
  time: neutralSvg('<circle cx="12" cy="12" r="8.25"/><path d="M12 7.4V12l3.1 1.9"/>'),
  // Browser window + play (automation).
  playwright: neutralSvg(
    '<rect x="3.25" y="4.75" width="17.5" height="14.5" rx="2"/><path d="M3.25 9.25h17.5"/><path d="m10.4 12.4 3.6 2-3.6 2z"/>',
  ),
  // Browser window + code brackets (developer tools / inspect).
  'chrome-devtools': neutralSvg(
    '<rect x="3.25" y="4.75" width="17.5" height="14.5" rx="2"/><path d="M3.25 9.25h17.5"/><path d="m9.5 12-2 2 2 2"/><path d="m14.5 12 2 2-2 2"/>',
  ),
  // Speech bubble with text lines (messaging).
  slack: neutralSvg(
    '<path d="M5 5.75A1.5 1.5 0 0 1 6.5 4.25h11A1.5 1.5 0 0 1 19 5.75v7.5a1.5 1.5 0 0 1-1.5 1.5H10l-4 3.25v-3.25H6.5A1.5 1.5 0 0 1 5 13.25z"/><path d="M9 9h6"/><path d="M9 12h4"/>',
  ),
  // Bar chart on axes (analytics / BI).
  tableau: neutralSvg(
    '<path d="M4.5 4.5v15h15"/><path d="M8.5 16.5v-4"/><path d="M12.5 16.5v-7"/><path d="M16.5 16.5v-2.5"/>',
  ),
  // Isometric cube (3D / game engine).
  unity: neutralSvg(
    '<path d="M12 3.5 20 8v8l-8 4.5L4 16V8z"/><path d="M4 8l8 4.5L20 8"/><path d="M12 12.5V20.5"/>',
  ),
};

/**
 * Connector id → self-contained inline SVG mark. Branded connectors get their
 * canonical simple-icons glyph; everything else gets a neutral category glyph.
 */
export const CONNECTOR_ICON_SVGS: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(BRAND_ICONS).map(([id, icon]) => [id, brandSvg(icon.path, `#${icon.hex}`)]),
  ),
  ...NEUTRAL_ICON_SVGS,
};

/** Connector ids whose mark is a real, published brand glyph (not a fallback). */
export const BRANDED_CONNECTOR_IDS: readonly string[] = Object.keys(BRAND_ICONS);

/** The inline SVG mark for a connector id, if one is defined. */
export function connectorIconSvg(id: string): string | undefined {
  return CONNECTOR_ICON_SVGS[id];
}
