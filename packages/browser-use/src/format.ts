/**
 * Render a {@link PageSnapshot} into the compact text the model reads. The
 * whole point is EFFICIENCY: one line per element, addressed by `[index]`, with
 * only the fields that help the model decide (role, name, and — for fields —
 * the current value / editable marker). Coordinates are intentionally omitted
 * from the text (the app resolves index → element); they live in `details` for
 * callers that want them.
 */
import type { PageSnapshot, SnapshotElement } from './perception.js';

function elementLine(el: SnapshotElement): string {
  const marks: string[] = [];
  if (el.editable) marks.push('editable');
  if (!el.inViewport) marks.push('below fold');
  const suffix = marks.length > 0 ? ` (${marks.join(', ')})` : '';
  const value = el.value !== undefined && el.value !== '' ? ` = "${el.value}"` : '';
  const name = el.name !== '' ? ` "${el.name}"` : '';
  return `[${el.index}] ${el.role}${name}${value}${suffix}`;
}

/** The human/model-facing snapshot text. */
export function formatSnapshot(snap: PageSnapshot): string {
  const s = snap.summary;
  const head: string[] = [`Page: "${s.title}" — ${s.url}`];
  if (s.headings.length > 0) head.push(`Headings: ${s.headings.slice(0, 5).join(' · ')}`);
  if (s.landmarks.length > 0) head.push(`Landmarks: ${s.landmarks.join(', ')}`);
  const scroll =
    s.maxScrollY > 0
      ? `Scroll: ${s.scrollY}/${s.maxScrollY}px${s.atBottom ? ' (bottom)' : ''}`
      : 'Scroll: none';
  head.push(scroll);
  if (s.canvasHeavy) {
    head.push('Note: canvas/WebGL-heavy page — clicks fall back to coordinates.');
  }

  const body =
    snap.elements.length > 0
      ? snap.elements.map(elementLine).join('\n')
      : '(no interactive elements found — try browser_read or browser_scroll)';

  const cap = s.truncated
    ? `\n\n(${snap.elements.length} of ${s.elementCount} interactive elements shown; scroll or re-snapshot for more)`
    : '';

  return `${head.join('\n')}\n\nInteractive elements (act by index):\n${body}${cap}`;
}
