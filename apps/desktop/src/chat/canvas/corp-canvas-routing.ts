/**
 * Corp (multi-agent) → canvas bridge: what the user SEES while a team works.
 *
 * It used to open a tab per surface — a file tab per path, a terminal tab per
 * node — and every one of them took focus as it appeared. jedd, trying to watch
 * a run: "if you click something and then you need to go hunting back for the
 * situation room tab once you click one of them ... needs to stay in place so we
 * can quickly and efficiently look around."
 *
 * So there is ONE tab now, "Agent activity", and it CHANGES to whatever the
 * followed agent is doing at that moment — the file it is writing, the command
 * it is running, the page it built. His shape, and it fixes the real problem:
 * the room stays where it is, the activity tab updates beside it, and moving
 * between the two is one click in a tab bar that no longer rearranges itself.
 *
 * Two rules hold it together:
 *  - ONE FOLLOWED NODE: only the subagent the user pinned drives the tab. Other
 *    nodes' work never yanks it away.
 *  - NOTHING STEALS FOCUS: every write goes in with `focus: false`. The tab
 *    appears, fills, and morphs in the background; the user decides when to look.
 *
 * The primitives it renders with — the terminal mirror text, the interactive-
 * command rule — are the chat's own, imported from ./agent-surfaces, so the two
 * paths cannot drift again.
 */
import type { CanvasController, CanvasTabSpec } from '@pi-desktop/canvas';
import type { OrgNodeView } from '@pi-desktop/coordination';
import { useEffect, useRef } from 'react';
import { useCanvasStore } from '../../state/canvas-store';
import { type CorpBlock, useCorpStore } from '../../state/corp-store';
import { corpFileBaseName, corpHtmlArtifact } from '../corp/corp-file-canvas';
import { corpBashSteps, currentCorpFile, isHtmlPath } from '../corp/corp-file-content';
import { mirrorCommandText, shortCommandTitle } from './agent-surfaces';
import { fileArtifactFromText } from './file-tabs';

/**
 * The ONE canvas tab a corp run drives. Constant, so it is the same tab all run
 * long: the user learns where it is once, and it is still there an hour later.
 */
export const AGENT_ACTIVITY_TAB_KEY = 'corp:activity';

/** Its title — stable on purpose. A title that renamed itself to each filename
 * made the tab bar shuffle under the cursor, which is the thing being fixed. */
export const AGENT_ACTIVITY_TITLE = 'Agent activity';

/**
 * What the activity tab should BE right now, from the followed agent's blocks:
 * the newest thing it touched. A command it ran is a live terminal; a file it
 * wrote is that file (the built page for html, the source otherwise).
 *
 * NEWEST WINS, across kinds. Deciding "file, else terminal" — which is what two
 * separate effects amounted to — pins the tab to whichever surface the agent
 * happened to use first and leaves it there while it does something else
 * entirely. What the tab is for is answering "what is it doing NOW".
 *
 * `subtitle` carries the specific thing (the filename, the command) so the tab
 * itself can stay named "Agent activity" without hiding what is inside it.
 * Returns undefined before the agent has touched anything.
 */
export function activitySpec(blocks: readonly CorpBlock[]): CanvasTabSpec | undefined {
  const bash = corpBashSteps(blocks);
  const lastCommand = bash[bash.length - 1];
  const file = currentCorpFile(blocks);
  // Index of each candidate in the block list decides which is more recent.
  const lastBashAt = lastIndex(blocks, (b) => b.kind === 'tool' && b.toolName === 'bash');
  const lastFileAt = lastIndex(blocks, (b) => b.kind === 'file' && b.path.length > 0);

  if (lastCommand !== undefined && lastBashAt > lastFileAt) {
    // Everything the agent has run, in one mirror — the shell it would have if
    // you were sitting next to it, not one terminal per command.
    const mirrorText = bash
      .map((s, i) => mirrorCommandText(s.command, s.output, i === bash.length - 1 && s.output === ''))
      .join('\n');
    return {
      kind: 'terminal',
      key: AGENT_ACTIVITY_TAB_KEY,
      title: AGENT_ACTIVITY_TITLE,
      subtitle: shortCommandTitle(lastCommand.command),
      data: { mirror: true, mirrorText },
    };
  }
  if (file === undefined) return undefined;
  if (isHtmlPath(file.path) && file.content.length > 0) {
    // An html file the agent is building: show the PAGE. Watching a site appear
    // is the whole point; the markup is a click away in the file tree.
    return {
      kind: 'html',
      key: AGENT_ACTIVITY_TAB_KEY,
      title: AGENT_ACTIVITY_TITLE,
      subtitle: corpFileBaseName(file.path),
      artifact: corpHtmlArtifact(file.path, file.content),
      streaming: file.streaming,
    };
  }
  return {
    kind: 'file',
    key: AGENT_ACTIVITY_TAB_KEY,
    title: AGENT_ACTIVITY_TITLE,
    subtitle: corpFileBaseName(file.path),
    filePath: file.path,
    breadcrumb: file.path.split(/[/\\]/).filter(Boolean),
    streaming: file.streaming,
    ...(file.content.length > 0 ? { artifact: fileArtifactFromText(file.path, file.content) } : {}),
    ...(file.addedLines !== undefined
      ? { addedLines: file.addedLines, removedLines: file.removedLines ?? 0 }
      : {}),
  };
}

/** Index of the LAST block matching `pred`, or -1. */
function lastIndex(blocks: readonly CorpBlock[], pred: (b: CorpBlock) => boolean): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i];
    if (b !== undefined && pred(b)) return i;
  }
  return -1;
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
 * A situation-room row was clicked: PIN that agent so the chat pane shows its
 * stream and the activity tab follows it — and LEAVE THE ROOM WHERE IT IS.
 *
 * It used to jump the canvas to the node's own file or terminal tab. That reads
 * well once and is unusable in practice: you click an engineer to see what it is
 * doing, the room disappears from under you, and getting back means hunting
 * through a tab bar that grew a tab for every file anyone touched. jedd: "keep
 * that tab open instead of moving to the subagent's tab immediately ... we need
 * to be able to quickly swap and monitor."
 *
 * So the click changes WHAT the surfaces show, never WHICH surface you are
 * looking at. The activity tab re-fills with the newly-pinned agent's work in
 * the background; the room stays in front, one click away from it.
 */
export function selectCorpNodeAndFocus(
  controller: CanvasController,
  taskId: string | null,
  node: OrgNodeView,
): void {
  useCorpStore.getState().selectNode(node);
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

  // The activity tab is opened ONCE per run and then updated in place. A key in
  // `closedByUser` was deliberately dismissed and is never reopened — the point
  // of a background surface is that dismissing it means something.
  const opened = useRef(false);
  const prevNodeCount = useRef(0);

  // Reset when the task changes (setTask already clears the store) so a fresh run
  // opens its own tab. `taskId` is the intended re-run trigger, not read in the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on task change
  useEffect(() => {
    opened.current = false;
    prevNodeCount.current = 0;
  }, [taskId]);

  /*
   * THE ONE SURFACE. Whatever the followed agent touched most recently IS the
   * activity tab: a file it is writing (code, or the built page for html), or a
   * command it is running. It morphs in place — same key, same id, so the tab
   * neither moves nor multiplies — and it never takes focus.
   */
  useEffect(() => {
    if (taskId === null || shownId === undefined) return;
    const blocks = workerBlocks[shownId] ?? [];
    const spec = activitySpec(blocks);
    if (spec === undefined) return;

    const existing = controller.getState().tabs.find((t) => t.key === AGENT_ACTIVITY_TAB_KEY);
    if (existing === undefined) {
      if (opened.current) return; // the user closed it — respect that
      opened.current = true;
      controller.upsertTab(AGENT_ACTIVITY_TAB_KEY, spec, { focus: false });
      useCanvasStore.getState().setCanvasOpen(true);
      return;
    }
    // Morph in place. Patch only what actually changed so an unchanged tick does
    // not re-commit canvas state (and re-render every surface) 20 times a second.
    const patch: Record<string, unknown> = {};
    if (existing.kind !== spec.kind) {
      // A KIND change replaces the whole surface: carry the new spec wholesale so
      // no stale field (a file path on a terminal, a mirror on a code tab) rides along.
      controller.updateTab(existing.id, { ...spec, title: AGENT_ACTIVITY_TITLE });
      return;
    }
    if (existing.subtitle !== spec.subtitle) patch.subtitle = spec.subtitle;
    if (spec.filePath !== undefined && existing.filePath !== spec.filePath) {
      patch.filePath = spec.filePath;
      patch.breadcrumb = spec.breadcrumb;
    }
    if (spec.streaming !== undefined && existing.streaming !== spec.streaming) {
      patch.streaming = spec.streaming;
    }
    if (spec.artifact !== undefined && existing.artifact?.content.text !== spec.artifact.content.text) {
      patch.artifact = spec.artifact;
    }
    if (spec.data !== undefined && existing.data?.mirrorText !== spec.data.mirrorText) {
      patch.data = spec.data;
    }
    if (
      spec.addedLines !== undefined &&
      (existing.addedLines !== spec.addedLines || existing.removedLines !== spec.removedLines)
    ) {
      patch.addedLines = spec.addedLines;
      patch.removedLines = spec.removedLines;
    }
    if (Object.keys(patch).length > 0) controller.updateTab(existing.id, patch);
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
