/**
 * Standalone situation-room demo route (`?situationDemo=1`) — the dev/demo
 * surface for the spec §11 war room, laid out like the real app: the chat
 * area on the LEFT, the canvas sidebar (with the situation room) on the
 * RIGHT. The room is driven by the scripted mock corp run through the SAME
 * tab/handler contract a real CoordinationEngine bridge will use, so what
 * you see here is exactly what a live run renders.
 *
 * Clicking a node in the room routes that worker's live stream into the left
 * area (mock per-worker streams + the stylized task-briefing bubble) — the
 * spec §11 click-through, demoable end to end.
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
  MOCK_TASK_ID,
  mockPeekHtml,
  replayableEvents,
  startMockCorpRun,
} from '@pi-desktop/canvas';
import type { ArtifactRef, OrgNodeView } from '@pi-desktop/coordination';
import { useEffect, useMemo, useState } from 'react';
import { useUserMode } from '../state/settings-store';
import { WorkerStreamPane } from './WorkerStreamPane';

export function SituationDemoView() {
  const controller = useMemo(() => createCanvasController(), []);
  const [selectedNode, setSelectedNode] = useState<OrgNodeView | undefined>(undefined);

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
    controller.upsertTab(tabKey, {
      kind: 'situation',
      title: 'Situation room',
      // Replayable: tab switches remount the surface; a fresh subscriber
      // replays history and the room rebuilds instantly (same wrapping a real
      // engine bridge would apply to TaskHandle.events).
      situationEvents: replayableEvents(handle.events),
      situationTaskId: handle.taskId,
      situationUserMode: userMode,
    });
    return () => handle.stop();
  }, [controller, tabKey, userMode]);

  // Selection lives app-side (the pane needs it too); the room highlights the
  // node via the tab's situationSelectedNodeId.
  const onSituationNodeSelect = (_tabId: string, node: OrgNodeView) => {
    setSelectedNode((prev) => (prev?.id === node.id ? undefined : node));
  };
  useEffect(() => {
    const tab = controller.getState().tabs.find((t) => t.key === tabKey);
    if (tab) controller.updateTab(tab.id, { situationSelectedNodeId: selectedNode?.id });
  }, [controller, selectedNode, tabKey]);

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

  return (
    <div className="flex h-full bg-bg-base" data-testid="situation-demo">
      {/* The chat area (left): the selected worker's live stream. */}
      <div className="flex min-w-0 flex-1 flex-col border-r border-border-subtle">
        <WorkerStreamPane key={selectedNode?.id ?? 'none'} node={selectedNode} />
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
