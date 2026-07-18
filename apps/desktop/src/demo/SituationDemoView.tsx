/**
 * Standalone situation-room demo route (`?situationDemo=1`) — the dev/demo
 * surface for the spec §11 war room, laid out like the real app: the chat
 * area on the LEFT, the canvas sidebar (with the situation room) on the
 * RIGHT. The room is driven by the scripted mock corp run through the SAME
 * tab/handler contract a real CoordinationEngine bridge will use, so what
 * you see here is exactly what a live run renders.
 *
 * FOLLOW-LIVE (mirrors the real app's corp store): the left pane is never
 * blank once the run starts — it auto-selects the top-most node actually
 * running (`followTarget` over each org-chart snapshot) and moves with the
 * action. Clicking a node PINS it; the pane offers "follow live" back.
 *
 * Query params:
 *   situationStartAt=<ms>    fast-forward into the run (default 0)
 *   situationSpeed=<mult>    clock multiplier (default 1; <1 slows the tail)
 *   situationUserMode=power  raw file paths + line deltas (default: the
 *                            app's persisted userMode setting)
 */
import {
  CanvasProvider,
  CanvasTabs,
  createCanvasController,
  followTarget,
  initialSituation,
  latestArtifact,
  MOCK_TASK_ID,
  mockPeekHtml,
  mockWorkerTranscriptAt,
  reduceSituation,
  replayableEvents,
  type SituationState,
  startMockCorpRun,
} from '@pi-desktop/canvas';
import type { ArtifactRef, OrgNodeView, WorkerTranscriptView } from '@pi-desktop/coordination';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CorpInlineTurn } from '../chat/corp/CorpInlineTurn';
import { useUserMode } from '../state/settings-store';
import { WorkerStreamPane } from './WorkerStreamPane';

export function SituationDemoView() {
  const controller = useMemo(() => createCanvasController(), []);
  // Follow-live + pin, exactly like the real app's corp store.
  const [liveNode, setLiveNode] = useState<OrgNodeView | undefined>(undefined);
  const [pinnedNode, setPinnedNode] = useState<OrgNodeView | undefined>(undefined);
  const liveRef = useRef<OrgNodeView | undefined>(undefined);

  // The inline-turn preview (additive): the SAME mock stream folded into a
  // SituationState and rendered as the in-chat CorpInlineTurn instead of the
  // worker pane. Toggled in the header, or seeded via ?situationInline=1.
  const [inlineTurn, setInlineTurn] = useState(() =>
    new URLSearchParams(window.location.search).has('situationInline'),
  );
  const [sitState, setSitState] = useState<SituationState>(() => initialSituation(MOCK_TASK_ID));
  const sitRef = useRef(sitState);
  sitRef.current = sitState;
  // The demo clock (for the mock transcripts): run-elapsed ms, honoring the
  // same startAt/speed query params the run itself uses.
  const clockRef = useRef({ started: Date.now(), startAt: 0, speed: 1 });

  // The app's persisted experience level, overridable per-demo via query.
  const settingsUserMode = useUserMode();
  const userMode = useMemo(() => {
    const param = new URLSearchParams(window.location.search).get('situationUserMode');
    return param === 'power' || param === 'user' ? param : settingsUserMode;
  }, [settingsUserMode]);

  const tabKey = `situation:${MOCK_TASK_ID}`;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const startAt = Number(params.get('situationStartAt') ?? '0') || 0;
    const speed = Number(params.get('situationSpeed') ?? '1') || 1;
    const handle = startMockCorpRun({ startAt, speed });
    clockRef.current = { started: Date.now(), startAt, speed };
    // Replayable: tab switches remount the surface; a fresh subscriber
    // replays history and the room rebuilds instantly (same wrapping a real
    // engine bridge would apply to TaskHandle.events).
    const events = replayableEvents(handle.events);
    // Follow-live: a second pass over the same stream folds each org-chart
    // snapshot into the followed node (top-most actually-running, sticky).
    // The same pass folds EVERY event into the inline-turn's SituationState.
    let cancelled = false;
    let sit = initialSituation(handle.taskId);
    setSitState(sit);
    void (async () => {
      for await (const event of events) {
        if (cancelled) return;
        sit = reduceSituation(sit, event);
        setSitState(sit);
        if (event.type !== 'org-chart') continue;
        const next = followTarget(event.chart, liveRef.current?.id) ?? liveRef.current;
        liveRef.current = next;
        setLiveNode(next);
        // Keep a pinned node's live state fresh (its gem must stay honest).
        setPinnedNode((prev) =>
          prev === undefined ? prev : (event.chart.nodes.find((n) => n.id === prev.id) ?? prev),
        );
      }
    })();
    controller.upsertTab(tabKey, {
      kind: 'situation',
      title: 'Situation room',
      situationEvents: events,
      situationTaskId: handle.taskId,
      situationUserMode: userMode,
    });
    return () => {
      cancelled = true;
      handle.stop();
    };
  }, [controller, tabKey, userMode]);

  // Pin on click (clicking the pinned node again resumes following); the room
  // highlights whichever node the left pane is SHOWING.
  const shownNode = pinnedNode ?? liveNode;
  const onSituationNodeSelect = (_tabId: string, node: OrgNodeView) => {
    setPinnedNode((prev) => (prev?.id === node.id ? undefined : node));
  };
  const shownNodeId = shownNode?.id;
  useEffect(() => {
    const tab = controller.getState().tabs.find((t) => t.key === tabKey);
    if (tab) controller.updateTab(tab.id, { situationSelectedNodeId: shownNodeId });
  }, [controller, shownNodeId, tabKey]);

  // "Peek at what we have so far": open the current best artifact in its own
  // canvas tab. The target is stubbed (the real engine hands back a build);
  // the affordance and routing are the real thing.
  const onSituationPeek = (_tabId: string, artifact: ArtifactRef) => {
    controller.upsertTab(`situation-peek:${MOCK_TASK_ID}`, {
      kind: 'html',
      title: 'Build snapshot',
      artifact: {
        id: `peek-${artifact.id}`,
        title: artifact.title,
        content: { kind: 'html', text: mockPeekHtml(artifact.title) },
      },
    });
  };

  // The inline turn's transcript source: the SAME deterministic mock the
  // worker pane replays, sampled at the run's elapsed clock (a real engine
  // bridge swaps this for `corp:worker-transcript`).
  const fetchTranscript = useCallback((nodeId: string): Promise<WorkerTranscriptView | null> => {
    const node = sitRef.current.chart.nodes.find((n) => n.id === nodeId);
    if (node === undefined) return Promise.resolve(null);
    const { started, startAt, speed } = clockRef.current;
    const elapsed = startAt + (Date.now() - started) * speed;
    return Promise.resolve(mockWorkerTranscriptAt(node, elapsed));
  }, []);

  const peekTarget = latestArtifact(sitState);
  const onInlinePeek = () => {
    if (peekTarget !== undefined) onSituationPeek('inline', peekTarget);
  };

  return (
    <div className="flex h-full bg-bg-base" data-testid="situation-demo">
      {/* The chat area (left): the followed/pinned worker's live stream, or
          the in-chat inline turn preview (the redesign's target reading). */}
      <div className="flex min-w-0 flex-1 flex-col border-r border-border-subtle">
        <div className="flex justify-end px-3 pt-2">
          <button
            type="button"
            className="pd-focusable rounded border border-border-subtle px-2 py-0.5 text-xs text-text-muted hover:text-text-secondary"
            data-testid="inline-turn-toggle"
            onClick={() => setInlineTurn((v) => !v)}
          >
            {inlineTurn ? 'View: inline turn' : 'View: worker stream'}
          </button>
        </div>
        {inlineTurn ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4" data-testid="inline-turn-demo">
            <CorpInlineTurn
              taskId={MOCK_TASK_ID}
              state={sitState}
              fetchTranscript={fetchTranscript}
              peekAvailable={peekTarget !== undefined}
              onPeek={onInlinePeek}
            />
          </div>
        ) : (
          <WorkerStreamPane
            key={shownNode?.id ?? 'none'}
            node={shownNode}
            pinned={pinnedNode !== undefined}
            onFollowLive={() => setPinnedNode(undefined)}
          />
        )}
      </div>
      {/* The canvas sidebar (right): the situation room lives here. */}
      <div className="w-[52%] min-w-[560px] max-w-[900px] flex-none p-2">
        <CanvasProvider controller={controller}>
          <CanvasTabs handlers={{ onSituationPeek, onSituationNodeSelect }} />
        </CanvasProvider>
      </div>
    </div>
  );
}
