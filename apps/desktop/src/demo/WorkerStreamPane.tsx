/**
 * The left-chat-area worker stream for the DEMO route (spec §11 click-through):
 * the followed/pinned node's live stream, rendered through the SAME
 * {@link WorkerPaneShell}/feed the real corp pane uses — the streaming text
 * tail with its typing caret, the live "Thinking…" block, named tool rows, the
 * current-action tail, and the context ring all render exactly as a live run
 * renders them.
 *
 * Demo wiring: the canvas mock synthesizes a real `WorkerTranscriptView` at
 * each clock tick (`mockWorkerTranscriptAt`) — the pane just ticks. A real
 * engine bridge swaps the mock for `corp:worker-transcript` (CorpWorkerPane).
 */

import { mockWorkerStreamEndMs, mockWorkerTranscriptAt } from '@pi-desktop/canvas';
import type { OrgNodeView } from '@pi-desktop/coordination';
import { useEffect, useMemo, useState } from 'react';
import { WorkerPaneShell } from '../chat/corp/CorpWorkerPane';

/** Clock tick for the mock's streaming reveal (fast enough to read as live). */
const TICK_MS = 120;

/** Wall-clock replay position; the pane is keyed by node id, so a new worker
 * remounts with a fresh clock. Stops ticking once the script has fully played. */
function useReplayClock(endMs: number): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => {
      const now = Date.now() - started;
      setElapsed(now);
      if (now > endMs + 500) clearInterval(timer);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [endMs]);
  return elapsed;
}

export function WorkerStreamPane({
  node,
  pinned = false,
  onFollowLive,
}: {
  node: OrgNodeView | undefined;
  /** The user pinned this node; shows the "follow live" way back. */
  pinned?: boolean;
  onFollowLive?: () => void;
}) {
  const endMs = useMemo(() => (node ? mockWorkerStreamEndMs(node) : 0), [node]);
  const elapsed = useReplayClock(endMs);
  const transcript = useMemo(
    () => (node ? mockWorkerTranscriptAt(node, elapsed) : null),
    [node, elapsed],
  );

  if (node === undefined || transcript === null) {
    return (
      <div className="pd-workerpane" data-testid="worker-pane">
        <div className="pd-workerpane-empty">
          <span>The run is getting started —</span>
          <span>the live view appears the moment work begins.</span>
        </div>
      </div>
    );
  }

  // "Working" while the mock is still replaying — the shell shows the live
  // chip, running chain shimmer, and the current-action tail exactly as the
  // real pane would for a mid-turn agent.
  const working = elapsed <= endMs;

  return (
    <WorkerPaneShell
      node={node}
      transcript={transcript}
      working={working}
      loading={false}
      pinned={pinned}
      onFollowLive={onFollowLive}
      testId="worker-pane"
    />
  );
}
