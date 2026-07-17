/**
 * The left-chat-area worker stream (spec §11 click-through): when a node in
 * the situation room is clicked, THIS pane shows that worker's live stream —
 * rendered like a normal thread (messages + tool/thinking chains through the
 * app's ActivityChain), EXCEPT the leading "user message" is the worker's
 * task, shown as the stylized {@link TaskBriefingBubble}.
 *
 * Demo wiring: streams come from the canvas mock (`mockWorkerStreamFor`) and
 * replay on a local clock. A real engine bridge swaps the mock for the
 * worker's actual transcript — the rendering below stays as-is.
 */

import {
  mockWorkerStreamFor,
  TaskBriefingBubble,
  type WorkerStreamEntry,
} from '@pi-desktop/canvas';
import type { OrgNodeView } from '@pi-desktop/coordination';
import {
  ActivityChain,
  type ActivityStepData,
  MessageRow,
  ShimmerText,
  Thread,
} from '@pi-desktop/ui';
import { useEffect, useMemo, useRef, useState } from 'react';

/** Wall-clock replay position, ticked coarsely (250ms) to reveal entries.
 * The pane is keyed by node id, so a new worker remounts with a fresh clock. */
function useReplayClock(lastAt: number): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => {
      const now = Date.now() - started;
      setElapsed(now);
      if (now > lastAt + 500) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [lastAt]);
  return elapsed;
}

/** Group revealed entries: consecutive steps merge into one activity chain. */
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

export function WorkerStreamPane({ node }: { node: OrgNodeView | undefined }) {
  const stream = useMemo(() => (node ? mockWorkerStreamFor(node) : undefined), [node]);
  const lastAt = stream?.entries.at(-1)?.at ?? 0;
  const elapsed = useReplayClock(lastAt);

  if (node === undefined || stream === undefined) {
    return (
      <div className="pd-workerpane" data-testid="worker-pane">
        <div className="pd-workerpane-empty">
          <span>Click a worker in the situation room</span>
          <span>to watch its live stream here.</span>
        </div>
      </div>
    );
  }

  const revealed = stream.entries.filter((e) => e.at <= elapsed);
  const streaming = revealed.length < stream.entries.length;
  const groups = groupEntries(revealed);
  const lastGroup = groups[groups.length - 1];

  return (
    <div className="pd-workerpane" data-testid="worker-pane">
      <div className="pd-workerpane-head">
        <span className="pd-sitroom-gem" data-state={streaming ? 'working' : 'idle'} aria-hidden>
          <span className="pd-sitroom-gem-glow" />
          <span className="pd-sitroom-gem-ring" />
          <span className="pd-sitroom-gem-core" />
        </span>
        <span className="pd-workerpane-title">{node.name}</span>
        <span>{streaming ? 'live' : 'caught up'}</span>
      </div>
      <div className="pd-workerpane-body pd-elastic-scroll">
        <Thread>
          {/* The leading "user turn" is the worker's TASK — visibly a briefing. */}
          <TaskBriefingBubble briefing={stream.briefing} />
          {groups.map((group) => {
            const isLast = group === lastGroup;
            if (group.kind === 'message') {
              return (
                <MessageRow key={group.key} kind="assistant">
                  <StreamedText text={group.text} live={isLast && streaming} />
                </MessageRow>
              );
            }
            // A live trailing chain marks its final step running (the shimmer).
            const steps = group.steps.map((step, i) =>
              isLast && streaming && i === group.steps.length - 1
                ? { ...step, status: 'running' as const }
                : step,
            );
            return (
              <ActivityChain
                key={group.key}
                steps={steps}
                defaultExpanded={false}
                active={isLast && streaming}
              />
            );
          })}
          {revealed.length === 0 ? (
            <div className="text-footnote text-text-muted">
              <ShimmerText>Connecting to the worker…</ShimmerText>
            </div>
          ) : null}
        </Thread>
      </div>
    </div>
  );
}

/** Types the newest message on; older messages render whole. */
function StreamedText({ text, live }: { text: string; live: boolean }) {
  const [shown, setShown] = useState(live ? 0 : text.length);
  const target = useRef(text.length);
  target.current = text.length;

  useEffect(() => {
    if (!live) {
      setShown(text.length);
      return undefined;
    }
    setShown(0);
    const timer = setInterval(() => {
      setShown((n) => {
        if (n >= target.current) {
          clearInterval(timer);
          return n;
        }
        return n + 3;
      });
    }, 28);
    return () => clearInterval(timer);
  }, [live, text]);

  return <span className="whitespace-pre-wrap">{text.slice(0, shown)}</span>;
}
