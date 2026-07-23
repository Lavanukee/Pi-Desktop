/**
 * Semantic tool PRELOAD (jedd, roadmap latency work).
 *
 * The classifier loads a small task preset; the model then discovers the rest on
 * demand with `tool_search`. That on-demand call is a whole extra round-trip
 * (prefill + a tool turn) before the model can act. This module removes it for
 * the common case: on EACH user message we semantic-search the full registry by
 * the message text and PRE-ACTIVATE the top couple of high-confidence matches —
 * so the tool the model is about to need is already in hand.
 *
 * Two rules make it safe + cheap:
 *   1. Append-only. We only ever return tools to ADD; the caller unions them onto
 *      the active set (see index.ts applyPreset), so the KV-cached prompt prefix
 *      stays a prefix and the follow-up prefill is not churned.
 *   2. Peers move together. The mac-computer-use and browser tools are PIPELINES —
 *      a snapshot is useless without click/type/scroll. So when a pipeline member
 *      is a strong match we pull in its whole {@link PEER_GROUPS peer group}
 *      (jedd: "if mac snapshot is loaded, the whole mac computer use pipeline
 *      should be as well"). A hard {@link MAX_PRELOAD_TOOLS} cap keeps a peer
 *      expansion from ballooning the prefix.
 *
 * Pure + dependency-light (only the name lists + the pure {@link searchTools}), so
 * it unit-tests without a live pi session.
 */
import { BROWSER_TOOL_NAMES } from '@pi-desktop/browser-use/tool-names';
import { MAC_COMPUTER_USE_TOOL_NAMES } from '@pi-desktop/mac-computer-use/tool-names';
import { MAC_CONNECTOR_TOOLS } from '@pi-desktop/mac-connectors/tool-names';
import { searchTools, type ToolLike } from '../tools/tool-search.js';

/**
 * Tool groups that load as a unit: activating one strong match pulls in the whole
 * pipeline. Each is a cohesive set where any single member is near-useless alone.
 */
export const PEER_GROUPS: readonly (readonly string[])[] = [
  MAC_COMPUTER_USE_TOOL_NAMES, // mac_snapshot ⇒ launch/click/type/key/scroll
  BROWSER_TOOL_NAMES, // browser_snapshot ⇒ navigate/click/type/scroll/…
  MAC_CONNECTOR_TOOLS, // one connector ⇒ the calendar/mail/messages/… suite
];

/** How many high-match "picks" to pre-activate per message (jedd: "the first 2"). */
export const PRELOAD_LIMIT = 2;

/**
 * Minimum {@link searchTools} score for a match to count as "reasonably high"
 * (jedd). searchTools scores per query term: exact tool-name token = 5, name
 * substring = 3, description token = 2, param token = 1. A threshold of 5 means a
 * match needs a genuine signal — a tool-name hit, or a substring hit plus a
 * description hit — not a lone coincidental description word.
 */
export const PRELOAD_MIN_SCORE = 5;

/** Hard ceiling on tools added in one turn, so a peer expansion can't balloon the
 * prompt prefix (2 picks × a 6-tool pipeline would otherwise be 12+). */
export const MAX_PRELOAD_TOOLS = 8;

export interface PreloadOptions {
  readonly limit?: number;
  readonly minScore?: number;
  readonly maxTools?: number;
  /** Names already active — never re-added; peers of an active match still load. */
  readonly activeToolNames?: readonly string[];
}

/** The peer group a tool belongs to, or `[name]` when it is a standalone tool. */
function peerGroupFor(name: string): readonly string[] {
  for (const group of PEER_GROUPS) if (group.includes(name)) return group;
  return [name];
}

/**
 * Given the user's message, return the tool names to PRE-ACTIVATE this turn: the
 * top `limit` search matches scoring ≥ `minScore` that contribute something new,
 * each expanded to its whole peer pipeline, intersected with the registered
 * tools, minus what's already active. Deterministic + append-only by
 * construction. Empty when nothing matches confidently (the common trivial-chat
 * case) so a plain "hi" never grows the prefix.
 */
export function preloadToolNames(
  prompt: string,
  tools: readonly ToolLike[],
  opts: PreloadOptions = {},
): string[] {
  const {
    limit = PRELOAD_LIMIT,
    minScore = PRELOAD_MIN_SCORE,
    maxTools = MAX_PRELOAD_TOOLS,
    activeToolNames = [],
  } = opts;
  if (prompt.trim().length === 0) return [];
  const active = new Set(activeToolNames);
  const registered = new Set(tools.map((t) => t.name));
  // Enough headroom that already-active high matches don't crowd out fresh ones.
  const matches = searchTools(tools, prompt, {
    limit: Math.max(12, limit * 6),
    activeToolNames,
  });

  const out: string[] = [];
  const seen = new Set<string>();
  let picks = 0;
  for (const m of matches) {
    if (picks >= limit || out.length >= maxTools) break;
    if (m.score < minScore) break; // sorted desc → the rest are below threshold too
    // Expand to the peer pipeline; keep only registered, not-active, not-yet-added.
    const fresh = peerGroupFor(m.name).filter(
      (n) => registered.has(n) && !active.has(n) && !seen.has(n),
    );
    if (fresh.length === 0) continue; // whole group already active ⇒ doesn't spend a pick
    for (const n of fresh) {
      if (out.length >= maxTools) break;
      seen.add(n);
      out.push(n);
    }
    picks += 1;
  }
  return out;
}
