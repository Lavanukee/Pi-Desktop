/**
 * Corp (multi-agent) → canvas bridge. The parallel of the chat's auto-routers
 * ({@link useBashTerminalCanvasRouting} / {@link useFileWriteCanvasRouting}),
 * but sourced from the CORP store (a running CorpEngine task) instead of
 * `usePiStore.messages`. It drives the SAME shared {@link CanvasController} so a
 * corp run lights the canvas exactly like a normal chat does — with three rules
 * that keep the workspace CLEAN and scoped to what the user is watching:
 *
 *  - ONE FOLLOWED NODE (C5): only the subagent the user is viewing in the chat
 *    (the pinned node, else the live-followed node — `shownCorpNode`) drives the
 *    canvas. Other nodes' writes/commands never open or steal a tab.
 *  - ONE FILE TAB (C4): the followed node's newest write shows in a SINGLE live
 *    file tab (its body typed in from the store, +N/−N from the file block). A new
 *    file REPLACES it — the prior corp file tab is closed, never stacked.
 *  - ONE TERMINAL PER NODE (C6): a node's shell commands mirror into ONE terminal
 *    tab (keyed by node), each command appended as `$ cmd\n\noutput` — not a fresh
 *    terminal per command.
 *
 * A delegation (a new org-chart node) brings the situation room forward. Growth
 * deltas refresh in place and never steal focus. Everything is guarded behind "a
 * corp task is active AND a node is being followed", so normal chat is untouched,
 * and a user-closed tab is not reopened (an `opened` set).
 */
import type { CanvasController } from '@pi-desktop/canvas';
import type { OrgNodeView } from '@pi-desktop/coordination';
import { useEffect, useRef } from 'react';
import { useCanvasStore } from '../../state/canvas-store';
import { useCorpStore } from '../../state/corp-store';
import {
  corpFileTabKey,
  corpFileTabSpec,
  corpHtmlTabKey,
  openCorpFileInCanvas,
  openOrUpdateCorpHtmlPreview,
} from '../corp/corp-file-canvas';
import { corpBashSteps, currentCorpFile, isHtmlPath } from '../corp/corp-file-content';
import { fileArtifactFromText } from './file-tabs';

/** Stable terminal-tab key for a corp node — ONE terminal per node (C6): every
 * command the node runs is appended into this single mirror, not a tab per call. */
function corpTerminalTabKey(nodeId: string): string {
  return `corpterm:${nodeId}`;
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
 * Focus the selected node's MOST-RECENT canvas surface — its live file / terminal
 * tab — so clicking a subagent drops the user INTO its work (the canvas
 * live-updates that node's files/terminal). Walks the node's blocks newest-first
 * and focuses the first that has an open tab (a file tab keyed by path, its ONE
 * terminal keyed by node). Returns false when the node has no surface yet (a
 * not-started node), so the caller can fall back to the room.
 */
function focusNodeLatestSurface(controller: CanvasController, nodeId: string): boolean {
  const blocks = useCorpStore.getState().workerBlocks[nodeId] ?? [];
  const tabs = controller.getState().tabs;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block === undefined) continue;
    let key: string | undefined;
    if (block.kind === 'file' && block.path.length > 0) key = corpFileTabKey(block.path);
    else if (block.kind === 'tool' && block.toolName === 'bash') key = corpTerminalTabKey(nodeId);
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
 * store's FOLLOWED node + its blocks and drives the controller. Only the followed
 * node's work reaches the canvas (C5).
 */
export function useCorpCanvasRouting(controller: CanvasController): void {
  const taskId = useCorpStore((s) => s.taskId);
  const workerBlocks = useCorpStore((s) => s.workerBlocks);
  // The ONE node the user is EXPLICITLY watching — the PINNED node (a clicked
  // subagent), the only node whose work opens/updates/focuses a canvas tab (C5).
  // Deliberately NOT the auto-live-follow node: that flips between engineers and
  // yanks the canvas to a node the chat isn't showing. When nothing is pinned the
  // promoted view is the situation room, so no per-node file/terminal auto-opens.
  const shownId = useCorpStore((s) => s.pinnedNode?.id);
  const nodeCount = useCorpStore((s) => s.situation?.chart.nodes.length ?? 0);

  // The SINGLE corp file/preview tab in play (path-keyed so the chat's own
  // file-click / refresh share it) — tracked so a NEW file closes the prior one
  // instead of stacking. Terminals we've opened, keyed by node (one each). A key
  // in `opened*` whose tab is gone was user-closed → not reopened.
  const openFileKey = useRef<string | null>(null);
  const openHtmlKey = useRef<string | null>(null);
  const openedFiles = useRef<Set<string>>(new Set());
  const openedHtml = useRef<Set<string>>(new Set());
  const openedTerminals = useRef<Set<string>>(new Set());
  const prevNodeCount = useRef(0);

  // Reset the bridge's memory when the task changes (setTask already clears the
  // store) so a fresh run reopens its own tabs. `taskId` is the intended re-run
  // trigger, not read in the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on task change
  useEffect(() => {
    openFileKey.current = null;
    openHtmlKey.current = null;
    openedFiles.current.clear();
    openedHtml.current.clear();
    openedTerminals.current.clear();
    prevNodeCount.current = 0;
  }, [taskId]);

  // FILE (C1/C2/C4): the followed node's NEWEST write shows in ONE live file tab,
  // typed in from the store's captured body, with the file block's +N/−N as the
  // one authoritative badge. A new file CLOSES the prior tab (reuse, never stack).
  // A user-closed tab is not reopened; growth refreshes in place, no focus steal.
  useEffect(() => {
    if (taskId === null || shownId === undefined) return;
    const file = currentCorpFile(workerBlocks[shownId] ?? []);
    if (file === undefined) return;

    const key = corpFileTabKey(file.path);
    // A new file for the followed node → close the prior auto file (+ its preview),
    // so a single corp file/preview tab stays in play.
    if (openFileKey.current !== null && openFileKey.current !== key) {
      const prior = controller.getState().tabs.find((t) => t.key === openFileKey.current);
      if (prior !== undefined) controller.closeTab(prior.id);
      openedFiles.current.delete(openFileKey.current);
      openFileKey.current = null;
      if (openHtmlKey.current !== null) {
        const priorHtml = controller.getState().tabs.find((t) => t.key === openHtmlKey.current);
        if (priorHtml !== undefined) controller.closeTab(priorHtml.id);
        openedHtml.current.delete(openHtmlKey.current);
        openHtmlKey.current = null;
      }
    }

    const badge =
      file.addedLines !== undefined
        ? { addedLines: file.addedLines, removedLines: file.removedLines ?? 0 }
        : undefined;
    const hasContent = file.content.length > 0;
    const existing = controller.getState().tabs.find((t) => t.key === key);

    if (existing === undefined) {
      if (!openedFiles.current.has(key)) {
        openedFiles.current.add(key);
        openFileKey.current = key;
        if (hasContent) {
          // Open the CODE tab from the real, captured write body (focused, streaming).
          controller.upsertTab(key, {
            ...corpFileTabSpec(file.path),
            streaming: file.streaming,
            artifact: fileArtifactFromText(file.path, file.content),
            ...(badge !== undefined ? badge : {}),
          });
        } else {
          // The body hasn't landed yet — best-effort peek (fills the instant it does).
          void openCorpFileInCanvas(controller, taskId, file.path, file.streaming, badge);
        }
        useCanvasStore.getState().setCanvasOpen(true);
      }
    } else {
      openFileKey.current = key;
      // Growth: append the newly-captured body + tick the badge, no focus steal.
      const patch: Record<string, unknown> = {};
      if (hasContent && existing.artifact?.content.text !== file.content) {
        patch.artifact = fileArtifactFromText(file.path, file.content);
      }
      if (existing.streaming !== file.streaming) patch.streaming = file.streaming;
      if (
        badge !== undefined &&
        (existing.addedLines !== badge.addedLines || existing.removedLines !== badge.removedLines)
      ) {
        patch.addedLines = badge.addedLines;
        patch.removedLines = badge.removedLines;
      }
      if (Object.keys(patch).length > 0) controller.updateTab(existing.id, patch);
    }

    // For an HTML file with live content, keep a secondary live preview building
    // alongside the focused code tab (opened after it, so it never steals focus).
    if (hasContent && isHtmlPath(file.path)) {
      openHtmlKey.current = corpHtmlTabKey(file.path);
      openOrUpdateCorpHtmlPreview(controller, file.path, file.content, openedHtml.current);
    }
  }, [workerBlocks, taskId, shownId, controller]);

  // TERMINAL (C5/C6): mirror the followed node's shell commands into ONE terminal
  // tab (keyed by node), each command appended into the same mirror — opened the
  // instant the first command fires, growing in place, never a tab per command.
  useEffect(() => {
    if (taskId === null || shownId === undefined) return;
    const steps = corpBashSteps(workerBlocks[shownId] ?? []);
    if (steps.length === 0) return;
    const key = corpTerminalTabKey(shownId);
    const mirrorText = steps.map((s) => corpMirrorText(s.command, s.output)).join('\n');
    const title = shortCommandTitle(steps[steps.length - 1]?.command ?? '') || 'Terminal';
    const existing = controller.getState().tabs.find((t) => t.key === key);
    if (existing === undefined) {
      if (openedTerminals.current.has(key)) return; // user closed it — leave it
      openedTerminals.current.add(key);
      controller.upsertTab(key, {
        kind: 'terminal',
        key,
        title,
        data: { mirror: true, mirrorText },
      });
      useCanvasStore.getState().setCanvasOpen(true);
    } else {
      const patch: Record<string, unknown> = {};
      if ((existing.data?.mirrorText as string | undefined) !== mirrorText) {
        patch.data = { mirror: true, mirrorText };
      }
      if (existing.title !== title) patch.title = title;
      if (Object.keys(patch).length > 0) controller.updateTab(existing.id, patch);
    }
  }, [workerBlocks, taskId, shownId, controller]);

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
