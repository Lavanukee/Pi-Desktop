/**
 * THEME 3 in the thread. Segments one assistant turn's blocks into render
 * units: visible text, standalone thoughts, and collapsed tool/thinking
 * CHAINS. A chain is a maximal run of consecutive thinking + tool-call blocks
 * with no text between them — it renders as a single dim past-tense summary
 * (ActivityChain) that expands to a stacked step list, then per-step content.
 *
 * Round-6 UNIFY: a thinking-ONLY run (no tools) is ALSO routed through the
 * ActivityChain so it gets the chain chrome (clock-icon "Thought for X" step +
 * connector line + "Done ✓" terminal) instead of a bare thought. Both a chain
 * and a thinking-only run are EXPANDED + live while the turn streams and this is
 * its trailing block, then COLLAPSE to their summary the moment the run is done
 * (the response text begins, or the turn ends) — driven by the `active` flag.
 * Media/preview steps route to a canvas tab via the shared controller.
 */

import { useCanvasTabs } from '@pi-desktop/canvas';
import type { ToolResultMsg } from '@pi-desktop/engine';
import { ActivityChain } from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import { usePiStore } from '../state/pi-slice';
import {
  type ActivityBlock,
  chainRunningFlags,
  type MappedStep,
  mapThinkingStep,
  mapToolStep,
} from './activity-mapping';
// Local module (NOT a package barrel) — keep the open-in-canvas action off the
// renderer-forbidden barrels (the gotcha); `openFileInCanvas` reads via IPC.
import { openFileInCanvas } from './canvas/file-tabs';

export { segmentBlocks } from './activity-mapping';

/**
 * Rough thinking-time estimate for a thinking-only chain. The engine carries no
 * per-block timestamps, so approximate the reasoning length at the live token
 * throughput (~4 chars/token). Honest-but-estimated; omitted when no throughput
 * is known or the estimate rounds below a second (→ a plain "Thought" pill).
 */
function estimateThoughtMs(text: string, tps: number | undefined): number | undefined {
  if (tps === undefined || tps <= 0) return undefined;
  const tokens = Math.max(1, Math.round(text.length / 4));
  const ms = Math.round((tokens / tps) * 1000);
  return ms >= 1000 ? ms : undefined;
}

/** Resolve a tool-arg path to an absolute one (join with the session cwd when it
 * arrived relative) so `openFileInCanvas`'s `fs:read-file` can find it. */
function resolveAbsPath(path: string, cwd: string | undefined): string {
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return path;
  if (cwd !== undefined && cwd.length > 0) return `${cwd.replace(/\/+$/, '')}/${path}`;
  return path;
}

/**
 * A collapsed tool/thinking chain wired to the canvas controller for media
 * steps. Also renders a thinking-ONLY run (no tools) so every thought gets the
 * chain chrome. `streaming` marks this as the live trailing block of the turn —
 * it drives BOTH the per-step running state AND the chain's `active` (expanded +
 * live) state, so the chain collapses to its summary the instant the run ends.
 */
export function ThreadActivityChain({
  blocks,
  resultForBlock,
  runningToolCalls,
  streaming,
  turnStartedAt,
  tps,
  onOpenFile,
}: {
  blocks: ActivityBlock[];
  /** Tool result keyed by tool-call id (owner-scoped by the caller). */
  resultForBlock: Map<string, ToolResultMsg>;
  runningToolCalls: string[];
  streaming: boolean;
  /** Wall-clock the owning assistant turn began (for the thinking duration). */
  turnStartedAt?: number;
  /** Live throughput (tok/s) used to estimate a thinking-only run's duration. */
  tps?: number;
  /**
   * Override the file-op row's "open in canvas" action (read/edit/skill). The
   * normal chat leaves this unset and opens the file off disk via `fs:read-file`;
   * the corp feed passes its own opener so a live corp-workspace file opens as a
   * streaming corp-peek instead (the workspace has no renderer-addressable path).
   */
  onOpenFile?: (path: string) => void;
}): ReactNode {
  const canvas = useCanvasTabs();
  const cwd = usePiStore((s) => s.session?.cwd ?? undefined);

  // Thinking duration (round-3 #A13/activity): the engine carries no per-block
  // timestamps, so approximate the model's thinking time as the pre-first-tool
  // window — from the turn start to the earliest tool result in the chain. The
  // whole window is attributed to the FIRST thinking step (summarizeActivity
  // sums per kind, so the aggregate reads "thought for Xs" regardless of split).
  const firstToolResultTs = blocks.reduce<number | undefined>((min, b) => {
    if (b.type !== 'toolCall') return min;
    const ts = resultForBlock.get(b.id)?.timestamp;
    if (ts === undefined) return min;
    return min === undefined ? ts : Math.min(min, ts);
  }, undefined);
  const hasTools = blocks.some((b) => b.type === 'toolCall');
  // Thinking-only run: no tool result to bound the window, so estimate from the
  // thought length + live throughput (round-6 unify — same estimate the old
  // standalone-thought path used, now feeding the chain summary "Thought for X").
  const thinkingText = blocks
    .filter((b): b is Extract<ActivityBlock, { type: 'thinking' }> => b.type === 'thinking')
    .map((b) => b.thinking)
    .join('');
  const thinkingMs =
    turnStartedAt !== undefined && firstToolResultTs !== undefined
      ? Math.max(0, firstToolResultTs - turnStartedAt)
      : hasTools
        ? 0
        : (estimateThoughtMs(thinkingText, tps) ?? 0);
  const firstThinkingIdx = blocks.findIndex((b) => b.type === 'thinking');

  // E1: only the LAST block of a live chain is present-tense; every settled prior
  // step stays past-tense (a new action must not re-present the ones before it).
  const runningFlags = chainRunningFlags(blocks, {
    streaming,
    hasResult: (id) => resultForBlock.get(id) !== undefined,
    runningToolCalls,
  });
  const steps: MappedStep[] = blocks.map((block, i) => {
    const running = runningFlags[i] ?? false;
    if (block.type === 'thinking') {
      return mapThinkingStep(
        block,
        running,
        !streaming && i === firstThinkingIdx ? thinkingMs : undefined,
      );
    }
    return mapToolStep(block, resultForBlock.get(block.id), running);
  });

  return (
    <ActivityChain
      data-testid="activity-chain"
      steps={steps.map((s) => s.data)}
      defaultExpanded={false}
      // Expanded + live while this run streams; collapses the moment it's done.
      active={streaming}
      onOpenCanvas={(_step, index) => {
        const spec = steps[index]?.tabSpec;
        if (spec?.key !== undefined) canvas.upsertTab(spec.key, spec);
      }}
      // A read/edit/skill row's primary click opens that file in the canvas
      // (deliverable A2). The full path lives on `step.detail`; resolve it against
      // the session cwd when it arrived relative so the IPC read can find it. When
      // the caller supplies an opener (the corp feed), defer to it instead.
      onOpenFile={(step) => {
        const path = step.detail;
        if (path === undefined || path.length === 0) return;
        if (onOpenFile !== undefined) {
          onOpenFile(path);
          return;
        }
        void openFileInCanvas(canvas.controller, resolveAbsPath(path, cwd), cwd);
      }}
    />
  );
}
