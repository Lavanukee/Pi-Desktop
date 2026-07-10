/**
 * Autocomplete trigger detection (ported logic from RemotePi's useAutocomplete):
 *  - `/foo` is a command only at the start of a line (matches pi's TUI).
 *  - `@foo` is a mention anywhere at a word boundary.
 * Operates on the text of the current line up to the caret; `tokenStart` is the
 * offset (within that text) of the trigger char, for in-place replacement.
 */
export type AcMode = 'mention' | 'slash' | null;

export interface AcToken {
  mode: AcMode;
  query: string;
  tokenStart: number;
}

export const EMPTY_TOKEN: AcToken = { mode: null, query: '', tokenStart: 0 };

export function detectToken(textUpToCaret: string): AcToken {
  const slash = textUpToCaret.match(/(?:^|\n)\/(\S*)$/);
  if (slash !== null) {
    const query = slash[1] ?? '';
    return { mode: 'slash', query, tokenStart: textUpToCaret.length - query.length - 1 };
  }
  const mention = textUpToCaret.match(/(?:^|\s)@([^\s]*)$/);
  if (mention !== null) {
    const query = mention[1] ?? '';
    return { mode: 'mention', query, tokenStart: textUpToCaret.length - query.length - 1 };
  }
  return EMPTY_TOKEN;
}
