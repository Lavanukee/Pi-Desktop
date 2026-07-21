/**
 * Tool-output truncation (jedd, 2026-07-20): a `bash` command like `ls -R ~` can
 * emit tens of thousands of tokens in one tool result — the screenshot showed a
 * 24,539-token `ls -R` blowing past a 16,384-token context in a single turn, and
 * the request then 400s ("exceeds the available context size"). The model rarely
 * needs the whole dump; it needs the shape. So we cap a tool result to ~1.5k
 * tokens and tell the model it was truncated (so it can narrow the command if it
 * needs more), keeping the HEAD (where the useful structure is) and the TAIL
 * (where an error / exit summary lands).
 *
 * Wired via pi's `tool_result` hook (see harness index.ts), which lets an
 * extension return replacement `content` for a tool result before it enters the
 * conversation — so this shrinks what the MODEL sees, not just the UI.
 */

/** ~chars per token for mixed code/CLI output — deliberately conservative (a
 * low ratio over-counts tokens, so we truncate a touch early rather than late). */
const CHARS_PER_TOKEN = 4;

/** Default cap: ~1.5k tokens (jedd). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1500;

/** Fraction of the char budget kept from the HEAD (the rest from the TAIL). */
const HEAD_FRACTION = 0.7;

export interface TruncateOptions {
  /** Token budget for the kept text (default {@link DEFAULT_MAX_OUTPUT_TOKENS}). */
  readonly maxTokens?: number;
  /** Chars-per-token estimate (default {@link CHARS_PER_TOKEN}). */
  readonly charsPerToken?: number;
}

export interface TruncateResult {
  readonly text: string;
  readonly truncated: boolean;
  /** Chars removed from the middle (0 when not truncated). */
  readonly removedChars: number;
}

/**
 * Truncate `text` to ~`maxTokens`, keeping head + tail with a middle elision
 * marker. Line-aware: it snaps the cut points to line boundaries so a code/CLI
 * dump isn't sliced mid-line. Returns the original untouched when it already
 * fits. Pure + unit-tested.
 */
export function truncateToolOutput(text: string, opts: TruncateOptions = {}): TruncateResult {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const cpt = opts.charsPerToken ?? CHARS_PER_TOKEN;
  const budget = Math.max(200, Math.floor(maxTokens * cpt));
  if (text.length <= budget) return { text, truncated: false, removedChars: 0 };

  const headBudget = Math.floor(budget * HEAD_FRACTION);
  const tailBudget = budget - headBudget;

  // Snap the head cut back to the last newline within the head budget, and the
  // tail cut forward to the next newline, so neither slice lands mid-line.
  let headEnd = text.lastIndexOf('\n', headBudget);
  if (headEnd < headBudget * 0.5) headEnd = headBudget; // no nearby newline → hard cut
  let tailStart = text.indexOf('\n', text.length - tailBudget);
  if (tailStart === -1 || tailStart > text.length - tailBudget * 0.5) {
    tailStart = text.length - tailBudget; // no nearby newline → hard cut
  }
  if (tailStart <= headEnd) return { text, truncated: false, removedChars: 0 };

  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);
  const removedChars = tailStart - headEnd;
  const removedTokens = Math.round(removedChars / cpt);
  const marker = `\n\n… [truncated ${removedChars.toLocaleString()} chars ≈ ${removedTokens.toLocaleString()} tokens — output capped at ~${maxTokens} tokens; narrow the command (e.g. target a subdirectory, add a filter, or pipe through \`head\`) if you need the omitted part] …\n\n`;
  return { text: head + marker + tail, truncated: true, removedChars };
}
