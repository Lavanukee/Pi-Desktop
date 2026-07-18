/**
 * The left-chat-area LIVE VIEW for a corp run (spec §11 click-through +
 * follow-live): the pane shows the node the app is following — auto-selected
 * the moment a task starts (the lead forming the vision, then whoever is
 * actually running) — or a node the user clicked/pinned in the situation room.
 *
 * The body is the node's REAL activity, STREAMED: the engine's per-node live
 * transcript (`corp:worker-transcript`, backed by `getWorkerTranscript`) is
 * polled while the agent is mid-turn, and
 *
 *  - the growing `streaming` tail renders as live assistant text that types on
 *    SMOOTHLY (the shown length eases toward the live target each frame, so it
 *    reads continuously, not in poll-sized jumps), or a force-open reasoning
 *    block ("Thinking…") whose content grows as the model reasons,
 *  - tool steps render NAMED ("Searched the web: <query>", "Reading <file>",
 *    "Ran: <cmd>") through the app's ActivityChain — never "Used a tool",
 *  - between streams the tail shows the node's real `currentAction` with the
 *    branded spinner — never a bare "working…" void,
 *  - the head carries a context ring filled from the RUN's real usage.
 *
 * NOTHING here is invented: a node that has produced no activity yet says so
 * honestly. Only reachable behind the experimental production-harness flag.
 * {@link WorkerPaneShell} + {@link CorpWorkerFeed} are shared with the demo
 * route's pane so the demo renders EXACTLY what a live run renders.
 */
import { TaskBriefingBubble } from '@pi-desktop/canvas';
import type { OrgNodeView, WorkerTranscriptView } from '@pi-desktop/coordination';
import {
  ActivityChain,
  type ActivityStepData,
  ContextGauge,
  MessageRow,
  ShimmerText,
  Spinner,
  ThinkingBlock,
  Thread,
} from '@pi-desktop/ui';
import { useEffect, useRef, useState } from 'react';
import { fetchWorkerTranscript } from '../../state/corp-connect';
import { useCorpStore } from '../../state/corp-store';

/** Live-transcript poll cadence: fast while text is streaming in, calm otherwise. */
const POLL_MS = 900;
const POLL_STREAMING_MS = 350;

type TranscriptLine = WorkerTranscriptView['lines'][number];

/** The last path segment (the filename shown on a collapsed step row). */
function baseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

/** The engine's raw "thinking" action reads as a live "thinking…" to a person. */
function actionText(action: string): string {
  return action === 'thinking' ? 'thinking…' : action;
}

/** The raw tool name → the step's ICON kind (the engine supplies the human label
 * + detail on the line; here we only pick the glyph). NEVER the file read for an
 * unknown tool — it falls to the neutral `tool` glyph. */
function toolIconKind(tool: string): ActivityStepData['kind'] {
  switch (tool) {
    case 'read':
    case 'cat':
    case 'view':
      return 'read';
    case 'write':
    case 'edit':
      return 'edit';
    case 'bash':
    case 'shell':
    case 'run':
    case 'exec':
      return 'bash';
    case 'web_search':
    case 'search':
    case 'search_web':
      return 'search';
    case 'web_fetch':
    case 'fetch':
      return 'browser-navigate';
    case 'ls':
    case 'list':
      return 'read';
    default:
      return 'tool';
  }
}

/** One renderable row of the live feed. */
type FeedRow =
  | { kind: 'message'; text: string; streaming: boolean }
  | { kind: 'thinking-live'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'step'; step: ActivityStepData };

/** A humanized fallback verb for a tool line missing its engine label. */
function fallbackToolLabel(rawTool: string): string {
  const words = rawTool.replace(/[_-]+/g, ' ').trim();
  return words.length > 0 ? `Used ${words}` : 'Running a step';
}

function lineToRow(line: TranscriptLine): FeedRow | null {
  switch (line.kind) {
    case 'file-touch': {
      // Engine lines read "writing <path>" — surface the path as a file step.
      const path = line.path ?? line.text.replace(/^writing\s+/i, '');
      return {
        kind: 'step',
        step: { kind: 'edit', label: line.label ?? 'Writing', detail: path, filename: path },
      };
    }
    case 'tool-call': {
      // The engine names the tool (label) + its arg (detail); `text` is the raw
      // tool name we map to a glyph. "Searched the web: <query>", "Reading <file>".
      const kind = toolIconKind(line.text);
      return {
        kind: 'step',
        step: {
          kind,
          label: line.label ?? fallbackToolLabel(line.text),
          ...(line.detail !== undefined ? { detail: line.detail } : {}),
          ...(line.path !== undefined ? { filename: baseName(line.path) } : {}),
        },
      };
    }
    case 'thinking':
      // The LIVE reasoning stream renders as a force-open block whose content
      // grows; a settled thought folds into the chain as a "Thought" step.
      if (line.streaming === true) return { kind: 'thinking-live', text: line.text };
      return {
        kind: 'step',
        step: {
          kind: 'thinking',
          label: 'Thought',
          ...(line.text.length > 0 ? { thought: line.text } : {}),
        },
      };
    case 'consult':
      return { kind: 'step', step: { kind: 'tool', label: 'Consulted', detail: line.text } };
    case 'note': {
      // Legacy turn markers ("— continued (turn 2) —") are pure noise — dropped.
      if (/^—\s*.+\s*—$/.test(line.text)) return null;
      return { kind: 'note', text: line.text };
    }
    default:
      return {
        kind: 'message',
        text: line.text,
        streaming: line.streaming === true,
      };
  }
}

/** Group consecutive steps into one ActivityChain; other rows pass through. */
type RenderGroup =
  | { kind: 'message'; text: string; streaming: boolean; key: string }
  | { kind: 'thinking-live'; text: string; key: string }
  | { kind: 'note'; text: string; key: string }
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

// ---------------------------------------------------------------------------
// The shared feed — renders a WorkerTranscriptView as a live stream
// ---------------------------------------------------------------------------

export interface CorpWorkerFeedProps {
  transcript: WorkerTranscriptView | null;
  /** The node is actually running right now (drives running/tail states). */
  working: boolean;
  loading: boolean;
  /** The node's chart state, for the honest empty line. */
  nodeState: OrgNodeView['state'];
}

/** The live feed body: briefing card + streamed rows + the current-action tail. */
export function CorpWorkerFeed({ transcript, working, loading, nodeState }: CorpWorkerFeedProps) {
  const hasLines = transcript !== null && transcript.lines.length > 0;
  const rows =
    transcript !== null
      ? transcript.lines.map(lineToRow).filter((r): r is FeedRow => r !== null)
      : [];
  const groups = groupRows(rows);
  const lastGroup = groups[groups.length - 1];
  const lastIsChain = lastGroup !== undefined && lastGroup.kind === 'chain';
  // A LIVE text/reasoning tail is on screen — the tail row would be redundant.
  const streamingTail =
    lastGroup !== undefined &&
    ((lastGroup.kind === 'message' && lastGroup.streaming) || lastGroup.kind === 'thinking-live');
  const currentAction = transcript?.currentAction;

  return (
    <Thread>
      {transcript !== null ? (
        <TaskBriefingBubble briefing={transcript.briefing} collapsible />
      ) : null}
      {groups.map((group, i) => {
        if (group.kind === 'message') {
          return (
            <MessageRow key={group.key} kind="assistant">
              <StreamedText text={group.text} live={group.streaming} />
            </MessageRow>
          );
        }
        if (group.kind === 'thinking-live') {
          // The model reasoning RIGHT NOW: force-open, content growing live.
          return (
            <ThinkingBlock key={group.key} status="running" active>
              {group.text}
            </ThinkingBlock>
          );
        }
        if (group.kind === 'note') {
          return (
            <div key={group.key} className="pd-workerpane-note">
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
      {/* The current-action tail: what the node is doing THIS instant, with the
          branded spinner — the anti-void row. Shown only when nothing above
          already reads as live (no streaming text tail, no active chain whose
          last step is shimmering) so it fills gaps instead of duplicating. */}
      {working && hasLines && !streamingTail && !lastIsChain && currentAction !== undefined ? (
        <div className="pd-workerpane-action" data-testid="corp-current-action">
          <Spinner size={12} />
          <span className="pd-workerpane-action-text">{actionText(currentAction)}</span>
        </div>
      ) : null}
      {!hasLines && !loading ? (
        <div className="pd-workerpane-tail">
          {working ? <ShimmerText>{emptyLine(nodeState)}</ShimmerText> : emptyLine(nodeState)}
        </div>
      ) : null}
      {loading && transcript === null ? (
        <div className="pd-workerpane-tail">
          <ShimmerText>Connecting to the live work…</ShimmerText>
        </div>
      ) : null}
    </Thread>
  );
}

/**
 * Smoothly-revealed streaming assistant text. While `live`, the shown length
 * EASES toward the growing target every animation frame (catching up faster the
 * further behind, with a floor so a steady stream always makes visible
 * progress) — so the text types on continuously instead of jumping in poll-sized
 * chunks. Settled text renders whole, as does everything under reduced motion.
 */
function StreamedText({ text, live }: { text: string; live: boolean }) {
  const reduced =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate = live && !reduced;

  const [shown, setShown] = useState(animate ? 0 : text.length);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const targetRef = useRef(text.length);
  targetRef.current = text.length;

  useEffect(() => {
    if (!animate) {
      setShown(targetRef.current);
      return undefined;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const target = targetRef.current;
      const cur = shownRef.current;
      if (cur < target) {
        const gap = target - cur;
        // Exponential ease toward the target, floored to ~90 chars/s so a steady
        // stream never stalls; ceil guarantees at least one glyph per frame.
        const step = Math.max(gap * (1 - Math.exp(-14 * dt)), 90 * dt);
        setShown(Math.min(target, cur + Math.max(1, Math.ceil(step))));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animate]);

  const count = animate ? Math.min(shown, text.length) : text.length;
  return <span className="whitespace-pre-wrap">{text.slice(0, count)}</span>;
}

// ---------------------------------------------------------------------------
// The shared shell — header (gem · name · live · context ring · mode) + scroll
// ---------------------------------------------------------------------------

export interface WorkerPaneShellProps {
  node: OrgNodeView;
  transcript: WorkerTranscriptView | null;
  working: boolean;
  loading: boolean;
  /** The user pinned this node (clicked it); shows the "follow live" way back. */
  pinned?: boolean;
  onFollowLive?: () => void;
  testId?: string;
}

export function WorkerPaneShell({
  node,
  transcript,
  working,
  loading,
  pinned = false,
  onFollowLive,
  testId = 'corp-worker-pane',
}: WorkerPaneShellProps) {
  const hasLines = transcript !== null && transcript.lines.length > 0;
  const streaming = transcript?.streaming === true;
  const contextPercent = transcript?.contextPercent;

  // Keep the feed pinned to the newest activity unless the user scrolled up.
  // The growth key tracks BOTH new lines and the streaming tail growing.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stickToEnd = useRef(true);
  const lastLine = transcript?.lines[transcript.lines.length - 1];
  const growthKey = (transcript?.lines.length ?? 0) * 1_000_000 + (lastLine?.text.length ?? 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: growthKey is the scroll trigger (feed growth), not read in the effect
  useEffect(() => {
    const el = bodyRef.current;
    if (el !== null && stickToEnd.current) el.scrollTop = el.scrollHeight;
  }, [growthKey]);

  return (
    <div className="pd-workerpane" data-testid={testId}>
      <div className="pd-workerpane-head">
        <span className="pd-sitroom-gem" data-state={node.state} aria-hidden>
          <span className="pd-sitroom-gem-glow" />
          <span className="pd-sitroom-gem-ring" />
          <span className="pd-sitroom-gem-core" />
        </span>
        <span className="pd-workerpane-title">{node.name}</span>
        {streaming ? (
          <ShimmerText>live</ShimmerText>
        ) : working ? (
          <span>live</span>
        ) : hasLines ? (
          <span>caught up</span>
        ) : null}
        {contextPercent !== undefined ? (
          <span
            className="pd-workerpane-gauge"
            title={`Context ${Math.round(contextPercent)}% full`}
          >
            <ContextGauge value={contextPercent / 100} size={14} />
          </span>
        ) : null}
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
        <CorpWorkerFeed
          transcript={transcript}
          working={working}
          loading={loading}
          nodeState={node.state}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The live pane — polls the engine's real transcript over IPC
// ---------------------------------------------------------------------------

/** True when a fresh snapshot shows nothing new (poll bursts must not re-render
 * or re-scroll an unchanged feed). Compares the growth surface: line count, the
 * tail's text, and the live flags. */
function sameTranscript(prev: WorkerTranscriptView, next: WorkerTranscriptView): boolean {
  if (prev.nodeId !== next.nodeId || prev.lines.length !== next.lines.length) return false;
  if (prev.streaming !== next.streaming || prev.currentAction !== next.currentAction) return false;
  if (prev.contextPercent !== next.contextPercent) return false;
  const a = prev.lines[prev.lines.length - 1];
  const b = next.lines[next.lines.length - 1];
  return a?.text === b?.text && a?.streaming === b?.streaming;
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

  // Fetch on node switch, then POLL (fast while the model streams, calm
  // otherwise) so the feed streams as the work happens.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
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
          setTranscript((prev) => (prev !== null && sameTranscript(prev, t) ? prev : t));
          // Thread the run's live context usage to the app's context ring.
          if (t.contextPercent !== undefined) {
            useCorpStore.getState().setContextPercent(t.contextPercent);
          }
        }
        timer = setTimeout(pull, t?.streaming === true ? POLL_STREAMING_MS : POLL_MS);
      });
    };
    pull();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [taskId, node.id]);

  return (
    <WorkerPaneShell
      node={node}
      transcript={transcript}
      working={working}
      loading={loading}
      pinned={pinned}
      onFollowLive={onFollowLive}
    />
  );
}
