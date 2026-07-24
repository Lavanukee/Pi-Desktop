/**
 * The Pi AGENT CURSOR — one visual identity for "Pi is driving", shared by
 * every surface that shows a phantom pointer:
 *
 *   - the browser-use virtual cursor injected into the canvas browser page
 *     (browser-scripts.ts `cursorCommand`), and
 *   - the Mac computer-use overlay window (mac/overlay.html — a STATIC page
 *     that cannot import this module, so it carries a byte-equal copy of the
 *     SVG with a SYNC comment pointing here; change BOTH together).
 *
 * The artwork (jedd's reference): a chunky, softly-rounded send-dart pointing
 * up-and-right, with a FROSTED body — a translucent pearl/lavender fill under a
 * top-left sheen and a thin bright-white keyline — over a soft luminous rim
 * glow. The glow lives on the host element via CSS `filter: drop-shadow(...)`
 * (AGENT_CURSOR_FILTER), NOT in the SVG, so the glyph stays crisp at any size.
 * The pointing TIP — the sharp TOP-LEFT point, like a normal cursor — is the
 * hotspot; clicks radiate from there. TIP fractions below place it exactly on
 * the target. (The glyph's right + bottom points are its two tails.)
 */

/** The tight viewBox around the glyph, and its width/height (aspect ≈ 1.097). */
export const AGENT_CURSOR_VIEWBOX = '8.14 8.24 26.56 24.21';
export const AGENT_CURSOR_VIEWBOX_W = 26.56;
export const AGENT_CURSOR_VIEWBOX_H = 24.21;
/** Tip (hotspot) position as a fraction of the box — the top-left point — for
 * transform-origin on press pops and for offsetting so translate() means "tip
 * at this point". */
export const AGENT_CURSOR_TIP_X_FRACTION = 0.085;
export const AGENT_CURSOR_TIP_Y_FRACTION = 0.052;

/** The rounded send-dart body (right-pointing, frosted). Shared by both surfaces. */
export const AGENT_CURSOR_PATH =
  'M 10.01 13.12 Q 8.00 8.00 13.04 10.21 L 30.55 17.89 Q 36.50 20.50 30.03 21.17 ' +
  'L 25.48 21.64 Q 22.00 22.00 20.85 25.31 L 19.64 28.78 Q 18.00 33.50 16.17 28.85 Z';

/** The CSS drop-shadow chain hosts should apply around the glyph: a faint depth
 * shadow, a tight bright-white rim, then a soft blue halo (the frosted glow). */
export const AGENT_CURSOR_FILTER =
  'drop-shadow(0 1px 2px rgba(10,12,40,0.42)) drop-shadow(0 0 4px rgba(205,210,255,0.9)) drop-shadow(0 0 11px rgba(139,155,255,0.55))';

/** The shared cursor SVG at `width` CSS px (height keeps the native aspect). */
export function agentCursorSvg(width: number): string {
  const height = Math.round((width * AGENT_CURSOR_VIEWBOX_H) / AGENT_CURSOR_VIEWBOX_W);
  return (
    `<svg width="${width}" height="${height}" viewBox="${AGENT_CURSOR_VIEWBOX}" xmlns="http://www.w3.org/2000/svg">` +
    '<defs>' +
    '<linearGradient id="pi-cur-body" x1="10" y1="9" x2="30" y2="30" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" stop-color="#ffffff" stop-opacity="0.97"/>' +
    '<stop offset="0.45" stop-color="#e7e6f6" stop-opacity="0.9"/>' +
    '<stop offset="1" stop-color="#c3c2e4" stop-opacity="0.86"/></linearGradient>' +
    '<linearGradient id="pi-cur-sheen" x1="10" y1="9" x2="22" y2="23" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/>' +
    '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>' +
    '</defs>' +
    `<path d="${AGENT_CURSOR_PATH}" fill="url(#pi-cur-body)" stroke="#ffffff" stroke-opacity="0.85" ` +
    'stroke-width="1.4" stroke-linejoin="round"/>' +
    `<path d="${AGENT_CURSOR_PATH}" fill="url(#pi-cur-sheen)" opacity="0.6"/></svg>`
  );
}
