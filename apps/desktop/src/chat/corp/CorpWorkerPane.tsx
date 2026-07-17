/**
 * The left-chat-area worker stream for a LIVE corp run (spec §11 click-through):
 * clicking a node in the situation room routes THAT worker's real captured turn
 * stream here, rendered like a normal thread — except the leading "user message"
 * is the worker's task, shown as the stylized {@link TaskBriefingBubble}.
 *
 * The transcript is the engine's REAL per-node activity (fetched over IPC,
 * `corp:worker-transcript`); a node with nothing captured yet falls back to a
 * generated preview (`mockWorkerStreamFor`) so a click always shows something.
 * Only reachable behind the experimental production-harness flag.
 */
import {
  mockWorkerStreamFor,
  TaskBriefingBubble,
  type WorkerStream,
  type WorkerStreamEntry,
} from '@pi-desktop/canvas';
import type { OrgNodeView, WorkerTranscriptView } from '@pi-desktop/coordination';
import {
  ActivityChain,
  type ActivityStepData,
  MessageRow,
  ShimmerText,
  Thread,
} from '@pi-desktop/ui';
import { useEffect, useMemo, useState } from 'react';
import { fetchWorkerTranscript } from '../../state/corp-connect';

/** Map a neutral transcript line to a rendered step, when it is step-shaped. */
function lineToStep(line: WorkerTranscriptView['lines'][number]): ActivityStepData | null {
  switch (line.kind) {
    case 'file-touch':
      return {
        kind: 'edit',
        label: 'Editing',
        detail: line.path ?? line.text,
        ...(line.path ? { filename: line.path } : {}),
      };
    case 'tool-call':
      return { kind: 'bash', label: 'Ran', detail: line.text, command: line.text };
    case 'consult':
      return { kind: 'tool', label: 'Consulted', detail: line.text };
    default:
      return null;
  }
}

/** Project the neutral transcript onto the canvas `WorkerStream` shape. */
function transcriptToStream(t: WorkerTranscriptView): WorkerStream {
  const entries: WorkerStreamEntry[] = t.lines.map((line) => {
    const step = lineToStep(line);
    return step !== null
      ? { at: line.at, kind: 'step', step }
      : { at: line.at, kind: 'message', text: line.text };
  });
  return { nodeId: t.nodeId, briefing: t.briefing, entries };
}

type RenderGroup =
  | { kind: 'message'; text: string; key: string }
  | { kind: 'chain'; steps: ActivityStepData[]; key: string };

function groupEntries(entries: readonly WorkerStreamEntry[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  for (const [i, entry] of entries.entries()) {
    if (entry.kind === 'message') {
      groups.push({ kind: 'message', text: entry.text, key: `m${i}` });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last !== undefined && last.kind === 'chain') last.steps.push({ ...entry.step });
    else groups.push({ kind: 'chain', steps: [{ ...entry.step }], key: `c${i}` });
  }
  return groups;
}

export function CorpWorkerPane({ node, taskId }: { node: OrgNodeView; taskId: string | null }) {
  const [transcript, setTranscript] = useState<WorkerTranscriptView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setTranscript(null);
    if (taskId === null) {
      setLoading(false);
      return undefined;
    }
    void fetchWorkerTranscript(taskId, node.id).then((t) => {
      if (!cancelled) {
        setTranscript(t);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [taskId, node.id]);

  // Prefer the REAL captured stream; fall back to a generated preview so a click
  // always routes something into the pane.
  const stream = useMemo(
    () => (transcript !== null ? transcriptToStream(transcript) : mockWorkerStreamFor(node)),
    [transcript, node],
  );
  const groups = groupEntries(stream.entries);

  return (
    <div className="pd-workerpane" data-testid="corp-worker-pane">
      <div className="pd-workerpane-head">
        <span className="pd-sitroom-gem" data-state="idle" aria-hidden>
          <span className="pd-sitroom-gem-glow" />
          <span className="pd-sitroom-gem-ring" />
          <span className="pd-sitroom-gem-core" />
        </span>
        <span className="pd-workerpane-title">{node.name}</span>
        <span>{transcript !== null ? 'live' : 'preview'}</span>
      </div>
      <div className="pd-workerpane-body pd-elastic-scroll">
        <Thread>
          <TaskBriefingBubble briefing={stream.briefing} />
          {groups.map((group) =>
            group.kind === 'message' ? (
              <MessageRow key={group.key} kind="assistant">
                <span className="whitespace-pre-wrap">{group.text}</span>
              </MessageRow>
            ) : (
              <ActivityChain key={group.key} steps={group.steps} defaultExpanded={false} />
            ),
          )}
          {loading && stream.entries.length === 0 ? (
            <div className="text-footnote text-text-muted">
              <ShimmerText>Connecting to the worker…</ShimmerText>
            </div>
          ) : null}
        </Thread>
      </div>
    </div>
  );
}
