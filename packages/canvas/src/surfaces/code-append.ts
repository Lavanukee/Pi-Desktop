import type { EditorState, TransactionSpec } from '@codemirror/state';

/**
 * Build the transaction that reconciles the editor's current document toward a
 * new full text, as the minimal change over the shared prefix. For the common
 * streaming case (new text extends the old) this is a pure append at the end;
 * for a mid-stream correction it replaces only the diverging suffix.
 *
 * Crucially it does NOT set `selection`, so CodeMirror maps the existing
 * selection through the change — a caret before the edit point is untouched, a
 * caret at the old end stays put (append text is inserted after it) — and it
 * sets `scrollIntoView: false` so streaming never yanks the viewport.
 *
 * Returns `null` when the document already equals `fullText` (no-op).
 */
export function streamingUpdateSpec(state: EditorState, fullText: string): TransactionSpec | null {
  const current = state.doc.toString();
  if (current === fullText) return null;

  const max = Math.min(current.length, fullText.length);
  let prefix = 0;
  while (prefix < max && current.charCodeAt(prefix) === fullText.charCodeAt(prefix)) {
    prefix += 1;
  }

  return {
    changes: { from: prefix, to: current.length, insert: fullText.slice(prefix) },
    scrollIntoView: false,
  };
}
