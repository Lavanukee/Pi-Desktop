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

/**
 * True when Accessibility told us nothing usable about this app.
 *
 * Plenty of real applications are like this — anything drawing its own UI
 * (Electron without the a11y tree enabled, games, Java apps, canvas-based
 * editors) exposes a window and nothing inside it. It is the normal case for a
 * large slice of the Mac, not an error.
 */
export function isAxOpaque(snap: MacSnapshot): boolean {
  return snap.elements.length === 0;
}

/**
 * The human/model-facing snapshot text.
 *
 * WHEN AX IS EMPTY, THIS IS NOT A DEAD END. It used to read "(no actionable AX
 * elements — the app may be AX-opaque; request a screenshot and use x,y clicks)",
 * which jedd rightly called useless: it spends a turn telling the model that the
 * tool it just called cannot help, and asks it to call the same tool again with a
 * flag. The caller now attaches the screenshot itself, so the model is looking at
 * the window in the SAME reply — and this text tells it what to do with it.
 */
export function formatMacSnapshot(snap: MacSnapshot): string {
  const head: string[] = [`App: "${snap.app}"${snap.window ? ` — window "${snap.window}"` : ''}`];
  if (isAxOpaque(snap)) {
    return [
      head.join('\n'),
      '',
      'This app does not expose its controls to Accessibility, so there are no',
      'indexes to act on. The screenshot attached below IS your view of it.',
      '',
      'CONTROL THE APPLICATION VIA COORDINATES: read the window in the image and',
      'pass x,y screen points to mac_click / mac_move / mac_drag, and text to',
      'mac_type. The window origin and size are given below, so a point you read',
      'off the image maps directly onto the screen.',
      snap.windowBounds !== undefined
        ? `\nWindow bounds (screen points): x=${snap.windowBounds.x} y=${snap.windowBounds.y} ` +
          `w=${snap.windowBounds.w} h=${snap.windowBounds.h}`
        : '',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }
  const body = snap.elements.map(elementLine).join('\n');
  const cap = snap.summary.truncated
    ? `\n\n(${snap.elements.length} of ${snap.summary.elementCount} elements shown; narrow the app or re-snapshot for more)`
    : '';
  return `${head.join('\n')}\n\nActionable elements (act by index):\n${body}${cap}`;
}
