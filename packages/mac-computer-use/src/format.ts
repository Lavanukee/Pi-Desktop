/**
 * Render a {@link MacSnapshot} into the compact text the model reads — one line
 * per element, addressed by `[index]`, with only the fields that help the model
 * decide (role, name, value, editable/focused markers). Coordinates are omitted
 * from the text (the app resolves index → element). Mirror of browser-use's
 * format.ts.
 */
import type { MacElement, MacSnapshot } from './protocol.js';

function elementLine(el: MacElement): string {
  const marks: string[] = [];
  if (el.editable) marks.push('editable');
  if (el.focused) marks.push('focused');
  if (el.enabled === false) marks.push('disabled');
  const suffix = marks.length > 0 ? ` (${marks.join(', ')})` : '';
  const value =
    el.value !== undefined && el.value !== '' && el.value !== el.name ? ` = "${el.value}"` : '';
  const name = el.name !== '' ? ` "${el.name}"` : '';
  return `[${el.index}] ${el.role}${name}${value}${suffix}`;
}

/** The human/model-facing snapshot text. */
export function formatMacSnapshot(snap: MacSnapshot): string {
  const head: string[] = [`App: "${snap.app}"${snap.window ? ` — window "${snap.window}"` : ''}`];
  const body =
    snap.elements.length > 0
      ? snap.elements.map(elementLine).join('\n')
      : '(no actionable AX elements — the app may be AX-opaque; request a screenshot and use x,y clicks)';
  const cap = snap.summary.truncated
    ? `\n\n(${snap.elements.length} of ${snap.summary.elementCount} elements shown; narrow the app or re-snapshot for more)`
    : '';
  return `${head.join('\n')}\n\nActionable elements (act by index):\n${body}${cap}`;
}
