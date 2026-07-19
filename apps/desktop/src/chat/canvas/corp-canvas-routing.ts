/**
 * Corp (multi-agent) → canvas bridge. The parallel of the chat's auto-routers
 * ({@link useBashTerminalCanvasRouting} / {@link useFileWriteCanvasRouting}),
 * but sourced from the CORP store (a running CorpEngine task) instead of
 * `usePiStore.messages`. It drives the SAME shared {@link CanvasController} so a
 * corp run lights the canvas exactly like a normal chat does:
 *
 *  - a worker running a shell command opens a live TERMINAL tab (its command +
 *    streamed output), keyed by the tool row so its output grows in place;
 *  - a worker writing a file opens a live FILE tab (with a +N/−N badge);
 *  - a delegation (a new org-chart node appears) focuses the SITUATION room.
 *
 * Auto-swap falls out of upsert/focus: an EXECUTION event (a NEW bash/file tab)
 * focuses its own tab; a DELEGATION focuses the situation room. Growth deltas
 * (more output, more lines) refresh in place and never steal focus — so the view
 * doesn't thrash. Everything is guarded behind "a corp task is active", so normal
 * chat is untouched. Tabs are deduped by a stable key and a user-closed tab is
 * not reopened (an `opened` set), so the bridge is bounded and leak-free.
 */
import type { CanvasController } from '@pi-desktop/canvas';
import type { OrgNodeView } from '@pi-desktop/coordination';
import { useEffect, useRef } from 'react';
import { useCanvasStore } from '../../state/canvas-store';
import { useCorpStore } from '../../state/corp-store';
import { corpFileTabKey, openCorpFileInCanvas } from '../corp/corp-file-canvas';

/** Stable terminal-tab key for a corp bash step — the node + its block index (the
 * blocks array is append-only and the output update replaces the row in place). */
function corpTerminalTabKey(nodeId: string, blockIndex: number): string {
  return `corpterm:${nodeId}:${blockIndex}`;
}

/** The xterm text for a mirror terminal: the command prompt + its output — the
 * SAME `$ cmd\n\n<output>` shape the chat's terminal router mirrors. */
function corpMirrorText(command: string, output: string): string {
  const body = output.length > 0 ? output : '(running…)';
  return `$ ${command}\n\n${body}\n`;
}

/** First few words of a command, clipped — the terminal tab's short title. */
function shortCommandTitle(command: string): string {
  const first = command.trim().split(/\s+/).slice(0, 3).join(' ');
  return first.length > 28 ? `${first.slice(0, 27)}…` : first;
}

/**
 * Focus the live task's situation-room tab (opened on promotion in ChatApp) and
 * ensure the rail is open. No-op when the tab isn't up yet. Shared by the
 * delegation auto-focus and the subagent-row click (STEP 4).
 */
export function focusSituationTab(controller: CanvasController, taskId: string | null): boolean {
  if (taskId === null) return false;
  const tab = controller.getState().tabs.find((t) => t.key === `situation:${taskId}`);
  if (tab === undefined) return false;
  controller.focusTab(tab.id);
  useCanvasStore.getState().setCanvasOpen(true);
  return true;
}

/**
 * Focus the selected node's MOST-RECENT canvas surface — its latest live file /
 * terminal tab — so clicking a subagent drops the user INTO its work (the canvas
 * live-updates that node's files/terminal). Walks the node's blocks newest-first
 * and focuses the first that has an open tab. Returns false when the node has no
 * surface yet (a not-started node), so the caller can fall back to the room.
 */
function focusNodeLatestSurface(controller: CanvasController, nodeId: string): boolean {
  const blocks = useCorpStore.getState().workerBlocks[nodeId] ?? [];
  const tabs = controller.getState().tabs;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block === undefined) continue;
    let key: string | undefined;
    if (block.kind === 'file' && block.path.length > 0) key = corpFileTabKey(block.path);
    else if (block.kind === 'tool' && block.toolName === 'bash')
      key = corpTerminalTabKey(nodeId, i);
    if (key === undefined) continue;
    const tab = tabs.find((t) => t.key === key);
    if (tab !== undefined) {
      controller.focusTab(tab.id);
      useCanvasStore.getState().setCanvasOpen(true);
      return true;
    }
  }
  return false;
}

/**
 * A situation-room subagent row was clicked: PIN the node's stream to the chat
 * pane AND scope the canvas to that node (STEP 4). A live/finished node with its
 * own surface drops the user straight into it (its latest file/terminal tab); a
 * not-started node (nothing to scope to) — or clicking the pinned node again to
 * unpin — brings the situation room forward instead. One place so the panel
 * wiring and the tests never drift.
 */
export function selectCorpNodeAndFocus(
  controller: CanvasController,
  taskId: string | null,
  node: OrgNodeView,
): void {
  useCorpStore.getState().selectNode(node);
  // `selectNode` toggles: clicking the pinned node again unpins it. Only scope
  // into the node while it is (still) the pinned one; otherwise return to the room.
  const stillPinned = useCorpStore.getState().pinnedNode?.id === node.id;
  if (stillPinned && focusNodeLatestSurface(controller, node.id)) return;
  focusSituationTab(controller, taskId);
}

/**
 * Mount alongside the chat routers in CanvasTabsPanel. Subscribes to the corp
 * store's per-node blocks + the org-chart node count and drives the controller.
 */
export function useCorpCanvasRouting(controller: CanvasController): void {
  const taskId = useCorpStore((s) => s.taskId);
  const workerBlocks = useCorpStore((s) => s.workerBlocks);
  const nodeCount = useCorpStore((s) => s.situation?.chart.nodes.length ?? 0);

  // Stable keys we've already opened — so a user-closed tab is not reopened on the
  // next delta, and we open each exactly once (the growth path is updateTab).
  const openedTerminals = useRef<Set<string>>(new Set());
  const openedFiles = useRef<Set<string>>(new Set());
  const prevNodeCount = useRef(0);

  // Reset the bridge's memory when the task changes (setTask already clears the
  // store) so a fresh run reopens its own tabs. `taskId` is the intended re-run
  // trigger, not read in the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on task change
  useEffect(() => {
    openedTerminals.current.clear();
    openedFiles.current.clear();
    prevNodeCount.current = 0;
  }, [taskId]);

  // Terminals + files: mirror every corp bash step and every file write into the
  // canvas. Guarded behind an active task so normal chat is unaffected.
  useEffect(() => {
    if (taskId === null) return;
    for (const [nodeId, blocks] of Object.entries(workerBlocks)) {
      blocks.forEach((block, index) => {
        if (block.kind === 'tool' && block.toolName === 'bash') {
          const command = block.detail ?? '';
          const key = corpTerminalTabKey(nodeId, index);
          const data: Record<string, unknown> = {
            mirror: true,
            mirrorText: corpMirrorText(command, block.output ?? ''),
          };
          const existing = controller.getState().tabs.find((t) => t.key === key);
          if (existing === undefined) {
            if (openedTerminals.current.has(key)) return; // user closed it — leave it
            openedTerminals.current.add(key);
            // A NEW terminal tab focuses (upsert) — the execution event swaps to it.
            controller.upsertTab(key, {
              kind: 'terminal',
              key,
              title: shortCommandTitle(command) || 'Terminal',
              data,
            });
            useCanvasStore.getState().setCanvasOpen(true); // slide the panel open
          } else if ((existing.data?.mirrorText as string | undefined) !== data.mirrorText) {
            // Output grew — refresh in place, no focus steal.
            controller.updateTab(existing.id, { data });
          }
          return;
        }
        if (block.kind === 'file') {
          const path = block.path;
          if (path.length === 0) return;
          const key = corpFileTabKey(path);
          const added = block.addedLines;
          const removed = block.removedLines;
          const existing = controller.getState().tabs.find((t) => t.key === key);
          if (existing === undefined) {
            if (openedFiles.current.has(key)) return; // user closed it — leave it
            openedFiles.current.add(key);
            // A NEW file tab opens streaming + focused (reuses the existing seam,
            // which reads the ProductPeek), carrying its live +N/−N badge.
            void openCorpFileInCanvas(controller, taskId, path, true, {
              addedLines: added,
              removedLines: removed,
            });
            useCanvasStore.getState().setCanvasOpen(true); // slide the panel open
          } else if (existing.addedLines !== added || existing.removedLines !== removed) {
            // The +N/−N grew — tick the badge in place, no focus steal.
            controller.updateTab(existing.id, {
              streaming: true,
              addedLines: added,
              removedLines: removed,
            });
          }
        }
      });
    }
  }, [workerBlocks, taskId, controller]);

  // Delegation: a NEW org-chart node (a team forms / a manager hires) brings the
  // situation room forward. Only on a genuine node-count increase — never on every
  // activity delta.
  useEffect(() => {
    if (taskId === null) return;
    const prev = prevNodeCount.current;
    prevNodeCount.current = nodeCount;
    if (nodeCount > prev && nodeCount > 1) focusSituationTab(controller, taskId);
  }, [nodeCount, taskId, controller]);
}
