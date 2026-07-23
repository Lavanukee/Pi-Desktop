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
 * The artwork (jedd's reference): a sleek arrow filled with a blue→purple
 * gradient (#4f7dff top-left → #7b3ff2 bottom-right), a thick white outline
 * with rounded joins, over a subtle dark drop shadow + soft bluish glow (the
 * shadows live on the host element via CSS `filter: drop-shadow(...)`, not in
 * the SVG, so the glyph itself stays crisp at any size).
 *
 * `paint-order: stroke` (the `paint-order="stroke"` attribute) renders the
 * doubled-width stroke UNDER the fill, so the visible outline sits fully
 * OUTSIDE the glyph and the gradient keeps the whole interior.
 */

/** Native aspect of the glyph's viewBox (34 × 40, tip at 8,5). */
export const AGENT_CURSOR_VIEWBOX_W = 34;
export const AGENT_CURSOR_VIEWBOX_H = 40;
/** Tip position as a fraction of the box — for transform-origin on press
 * dips and for offsetting so translate() means "tip at this point". */
export const AGENT_CURSOR_TIP_X_FRACTION = 8 / 34;
export const AGENT_CURSOR_TIP_Y_FRACTION = 5 / 40;

/** The CSS drop-shadow chain hosts should apply around the glyph. */
export const AGENT_CURSOR_FILTER =
  'drop-shadow(0 1.5px 2.5px rgba(8,10,30,0.5)) drop-shadow(0 0 10px rgba(79,125,255,0.5))';

/** The shared cursor SVG at `width` CSS px (height keeps the native aspect). */
export function agentCursorSvg(width: number): string {
  const height = Math.round((width * AGENT_CURSOR_VIEWBOX_H) / AGENT_CURSOR_VIEWBOX_W);
  return (
    `<svg width="${width}" height="${height}" viewBox="0 0 34 40" xmlns="http://www.w3.org/2000/svg">` +
    '<defs><linearGradient id="pi-cur-g" x1="8" y1="5" x2="26" y2="34" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" stop-color="#4f7dff"/><stop offset="1" stop-color="#7b3ff2"/>' +
    '</linearGradient></defs>' +
    '<path d="M8 5 L8 31.2 L14.5 25 L19.3 35.7 L24.1 33.5 L19.3 23 L27.5 23 Z" ' +
    'fill="url(#pi-cur-g)" stroke="#fff" stroke-width="4.8" paint-order="stroke" ' +
    'stroke-linejoin="round" stroke-linecap="round"/></svg>'
  );
}
