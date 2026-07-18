/**
 * The left-chat-area LIVE VIEW for a corp run (spec §11 click-through +
 * follow-live): the pane shows the node the app is following — auto-selected
 * the moment a task starts (the lead forming the vision, then whoever is
 * actually running) — or a node the user clicked/pinned in the situation room.
 *
 * The body is the node's REAL activity, streamed: the engine's per-node live
 * transcript (`corp:worker-transcript`, backed by `getWorkerTranscript`) is
 * polled while the agent is mid-turn, and its tool calls render as human rows
 * ("Read a file", "Writing src/ecs.ts", "Ran a command") threaded through the
 * app's ActivityChain — NOT a static briefing. The stylized briefing bubble
 * stays as the collapsible header. NOTHING here is invented: a node that has
 * produced no activity yet says so honestly (no generated preview streams).
 * Only reachable behind the experimental production-harness flag.
 */
import { TaskBriefingBubble } from '@pi-desktop/canvas';
import type { OrgNodeView, WorkerTranscriptView } from '@pi-desktop/coordination';
import {
  ActivityChain,
  type ActivityStepData,
  MessageRow,
  ShimmerText,
  Thread,
} from '@pi-desktop/ui';
import { useEffect, useRef, useState } from 'react';
import { fetchWorkerTranscript } from '../../state/corp-connect';

/** Live-transcript poll cadence while the node's agent is mid-turn. */
const POLL_MS = 900;

type TranscriptLine = WorkerTranscriptView['lines'][number];

/** A tool-call line (the raw tool name) → a human step row. */
function toolStep(tool: string): ActivityStepData {
  switch (tool) {
    case 'read':
      return { kind: 'read', label: 'Read a file' };
    case 'write':
    case 'edit':
      return { kind: 'edit', label: 'Edited a file' };
    case 'bash':
      return { kind: 'bash', label: 'Ran a command' };
    case 'grep':
    case 'glob':
    case 'find':
      return { kind: 'tool', label: 'Searched the code' };
    case 'ls':
    case 'list':
      return { kind: 'read', label: 'Looked around the project' };
    default:
      return { kind: 'tool', label: `Used ${tool}` };
  }
}

/** One renderable row of the live feed. */
type FeedRow =
  | { kind: 'message'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'turn'; text: string }
  | { kind: 'step'; step: ActivityStepData };

function lineToRow(line: TranscriptLine): FeedRow {
  switch (line.kind) {
    case 'file-touch': {
      // Engine lines read "writing <path>" — surface the path as a file step.
      const path = line.path ?? line.text.replace(/^writing\s+/i, '');
      return {
        kind: 'step',
        step: { kind: 'edit', label: 'Writing', detail: path, filename: path },
      };
    }
    case 'tool-call':
      return { kind: 'step', step: toolStep(line.text) };
    case 'consult':
      return { kind: 'step', step: { kind: 'tool', label: 'Consulted', detail: line.text } };
    case 'note': {
      // Turn markers ("— continued (turn 2) —") render as quiet dividers.
      const turn = line.text.match(/^—\s*(.+?)\s*—$/);
      if (turn?.[1] !== undefined) return { kind: 'turn', text: turn[1] };
      return { kind: 'note', text: line.text };
    }
    default:
      return { kind: 'message', text: line.text };
  }
}

/** Group consecutive steps into one ActivityChain; other rows pass through. */
type RenderGroup =
  | { kind: 'message'; text: string; key: string }
  | { kind: 'note'; text: string; key: string }
  | { kind: 'turn'; text: string; key: string }
  | { kind: 'chain'; steps: ActivityStepData[]; key: string };

function groupRows(rows: readonly FeedRow[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  for (const [i, row] of rows.entries()) {
    if (row.kind === 'step') {
      const last = groups[groups.length - 1];
      if (last !== undefined && last.kind === 'chain') last.steps.push({ ...row.step });
      else groups.push({ kind: 'chain', steps: [{ ...row.step }], key: `c${i}` });
      continue;
    }
    groups.push({ ...row, key: `${row.kind[0]}${i}` });
  }
  return groups;
}

/** Honest empty-state line for a node with no captured activity yet. */
function emptyLine(state: OrgNodeView['state']): string {
  switch (state) {
    case 'working':
      return 'Connecting to the live work…';
    case 'blocked':
      return 'Waiting — this part of the work is blocked.';
    case 'done':
      return 'Finished — nothing was captured for this step.';
    case 'retired':
      return 'This part of the team has stepped away.';
    default:
      return 'Queued — this part of the work hasn’t started yet.';
  }
}

export interface CorpWorkerPaneProps {
  node: OrgNodeView;
  taskId: string | null;
  /** The user pinned this node (clicked it); shows the "follow live" way back. */
  pinned?: boolean;
  onFollowLive?: () => void;
}

export function CorpWorkerPane({
  node,
  taskId,
  pinned = false,
  onFollowLive,
}: CorpWorkerPaneProps) {
  const [transcript, setTranscript] = useState<WorkerTranscriptView | null>(null);
  const [loading, setLoading] = useState(true);
  const working = node.state === 'working';
  const hasLines = transcript !== null && transcript.lines.length > 0;

  // Fetch on node switch, then POLL while the agent is actually mid-turn (or
  // until the first transcript lands) so the feed streams as work happens.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setTranscript(null);
    if (taskId === null) {
      setLoading(false);
      return undefined;
    }
    const pull = () => {
      void fetchWorkerTranscript(taskId, node.id).then((t) => {
        if (cancelled) return;
        setLoading(false);
        if (t !== null) {
          // Only take a new snapshot when it actually grew — poll bursts must
          // not re-render (or re-scroll) an unchanged feed.
          setTranscript((prev) =>
            prev !== null && prev.nodeId === t.nodeId && prev.lines.length === t.lines.length
              ? prev
              : t,
          );
        }
      });
    };
    pull();
    const timer = setInterval(pull, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [taskId, node.id]);

  // Keep the feed pinned to the newest activity unless the user scrolled up.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stickToEnd = useRef(true);
  const lineCount = transcript?.lines.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: lineCount is the scroll trigger (new feed rows), not read in the effect
  useEffect(() => {
    const el = bodyRef.current;
    if (el !== null && stickToEnd.current) el.scrollTop = el.scrollHeight;
  }, [lineCount]);

  const rows = transcript !== null ? transcript.lines.map(lineToRow) : [];
  const groups = groupRows(rows);
  // The trailing chain streams: its last step shimmers while the agent runs.
  const lastGroup = groups[groups.length - 1];
  const lastIsChain = lastGroup !== undefined && lastGroup.kind === 'chain';

  return (
    <div className="pd-workerpane" data-testid="corp-worker-pane">
      <div className="pd-workerpane-head">
        <span className="pd-sitroom-gem" data-state={node.state} aria-hidden>
          <span className="pd-sitroom-gem-glow" />
          <span className="pd-sitroom-gem-ring" />
          <span className="pd-sitroom-gem-core" />
        </span>
        <span className="pd-workerpane-title">{node.name}</span>
        {hasLines ? <span>live</span> : null}
        <span className="pd-workerpane-mode">
          {pinned ? (
            <>
              <span>pinned</span>
              <button
                type="button"
                className="pd-workerpane-follow pd-focusable"
                data-testid="corp-follow-live"
                title="Go back to watching whoever is working right now"
                onClick={onFollowLive}
              >
                ⇄ Follow live
              </button>
            </>
          ) : (
            <span data-testid="corp-following">following live</span>
          )}
        </span>
      </div>
      <div
        className="pd-workerpane-body pd-elastic-scroll"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        <Thread>
          {transcript !== null ? (
            <TaskBriefingBubble briefing={transcript.briefing} collapsible />
          ) : null}
          {groups.map((group, i) => {
            if (group.kind === 'message') {
              return (
                <MessageRow key={group.key} kind="assistant">
                  <span className="whitespace-pre-wrap">{group.text}</span>
                </MessageRow>
              );
            }
            if (group.kind === 'note') {
              return (
                <div key={group.key} className="pd-workerpane-note">
                  {group.text}
                </div>
              );
            }
            if (group.kind === 'turn') {
              return (
                <div key={group.key} className="pd-workerpane-turn" aria-hidden>
                  {group.text}
                </div>
              );
            }
            const isLast = lastIsChain && i === groups.length - 1;
            const steps =
              isLast && working
                ? group.steps.map((step, s) =>
                    s === group.steps.length - 1 ? { ...step, status: 'running' as const } : step,
                  )
                : group.steps;
            return (
              <ActivityChain
                key={group.key}
                steps={steps}
                defaultExpanded={false}
                active={isLast && working}
              />
            );
          })}
          {working && hasLines && !lastIsChain ? (
            <div className="pd-workerpane-tail">
              <ShimmerText>working…</ShimmerText>
            </div>
          ) : null}
          {!hasLines && !loading ? (
            <div className="pd-workerpane-tail">
              {working ? <ShimmerText>{emptyLine(node.state)}</ShimmerText> : emptyLine(node.state)}
            </div>
          ) : null}
          {loading && transcript === null ? (
            <div className="pd-workerpane-tail">
              <ShimmerText>Connecting to the live work…</ShimmerText>
            </div>
          ) : null}
        </Thread>
      </div>
    </div>
  );
}
