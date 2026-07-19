/**
 * What the LIVE chat thread renders for the corp run right now — the single
 * source of truth for the "you never left your conversation" reframe (Points
 * 1/3/6). Pure so ChatThread's branch is trivially testable:
 *
 *  - `stream`   — a node's live feed (CorpChatStream): a PINNED subagent the user
 *                 drilled into, or (pre-promotion) the solo CEO/root streaming.
 *  - `waiting`  — the CEO "Waiting for N subagents to finish" indicator
 *                 (CorpInlineTurn): the DEFAULT promoted view when nothing is
 *                 pinned. Explicit drill-in, never an auto-followed leaf.
 *  - `starting` — the gap between submit and the first agent (never blank).
 *  - `none`     — no corp task; the thread is a normal chat.
 */
import type { SituationState } from '@pi-desktop/canvas';
import type { OrgNodeView } from '@pi-desktop/coordination';

export type CorpChatView =
  | { readonly kind: 'stream'; readonly node: OrgNodeView }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'none' };

export interface CorpChatViewInput {
  readonly taskId: string | null;
  readonly situation: SituationState | null;
  readonly liveNode: OrgNodeView | null;
  readonly pinnedNode: OrgNodeView | null;
}

/**
 * Decide the thread's corp view. A PIN always wins (the user drilled into that
 * subagent). With no pin, a PROMOTED run (a team formed: > 1 chart node) shows
 * the CEO-waiting indicator — NOT an auto-followed worker (the owner wants
 * explicit drill-in). A pre-promotion run streams the solo CEO/root so the
 * original model is on screen from the first event.
 */
export function corpChatView(input: CorpChatViewInput): CorpChatView {
  const { taskId, situation, liveNode, pinnedNode } = input;
  if (taskId === null) return { kind: 'none' };
  if (pinnedNode !== null) return { kind: 'stream', node: pinnedNode };
  const promoted = (situation?.chart.nodes.length ?? 0) > 1;
  if (promoted) return { kind: 'waiting' };
  const shown = liveNode ?? situation?.chart.nodes[0] ?? null;
  if (shown !== null) return { kind: 'stream', node: shown };
  return { kind: 'starting' };
}

/** True when the run has a build snapshot to open (drives the inline peek button). */
export function corpPeekAvailable(situation: SituationState | null): boolean {
  if (situation === null) return false;
  return situation.artifacts.length > 0 || (situation.result?.artifacts?.length ?? 0) > 0;
}
