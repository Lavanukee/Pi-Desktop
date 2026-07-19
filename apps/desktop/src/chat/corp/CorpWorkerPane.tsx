/**
 * The left-chat-area LIVE VIEW for a corp run (spec §11 click-through +
 * follow-live): the pane shows the node the app is following — auto-selected
 * the moment a task starts (the lead forming the vision, then whoever is
 * actually running) — or a node the user clicked/pinned in the situation room.
 *
 * The body is the node's REAL activity, rendered through the SAME pipeline the
 * normal chat uses: a {@link WorkerTranscriptView} is converted to pi-slice
 * `AssistantMsg` blocks ({@link transcriptToAssistantView}) and handed to
 * {@link AssistantGroup} — so the corp feed IS the normal chat's `segmentGroup`
 * → `Markdown` + `ThreadActivityChain` render:
 *
 *  - message text renders through the app's `<Markdown>` (code fences, lists,
 *    inline code); a JSON payload fences to a ```json code block; a written tool
 *    call the local model streamed as TEXT splits out into a real activity row,
 *  - tool / file steps render as the chain's NAMED rows ("Searched the web:
 *    <query>", "Reading <file>", the "Editing a file" +N row) — never raw markup,
 *  - a thinking run is an ActivityChain (its rail shows WHILE it streams), and a
 *    new block APPENDS in place (append-stable segment keys) instead of
 *    re-mounting the whole chain (no scroll-to-top),
 *  - the head carries a context ring filled from the RUN's real usage.
 *
 * NOTHING here is invented: a node that has produced no activity yet says so
 * honestly. {@link WorkerPaneShell} + {@link CorpWorkerFeed} are shared with the
 * demo route's pane so the demo renders EXACTLY what a live run renders.
 */
import { formatDuration, TaskBriefingBubble } from '@pi-desktop/canvas';
import type { OrgNodeView, WorkerTranscriptView } from '@pi-desktop/coordination';
import { ContextGauge, MessageRow, ShimmerText, Spinner, Thread } from '@pi-desktop/ui';
import { useEffect, useRef, useState } from 'react';
import { fetchWorkerTranscript } from '../../state/corp-connect';
import { useCorpStore } from '../../state/corp-store';
import { AssistantGroup } from '../AssistantGroup';
import { transcriptToAssistantView } from './corp-blocks';

/** Live-transcript poll cadence: fast while text is streaming in, calm otherwise.
 * The streaming interval is tight so a growing message tail reads continuous,
 * not chunky — the feed re-renders the whole (larger) text each poll, which is
 * the normal chat's incremental-parse behavior. */
const POLL_MS = 900;
const POLL_STREAMING_MS = 120;

/** The engine's raw "thinking" action reads as a live "thinking…" to a person. */
function actionText(action: string): string {
  return action === 'thinking' ? 'thinking…' : action;
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
      // A not-yet-started subagent: its contract briefing still shows above; this
      // is the honest "hasn't been picked up yet" tail (Point 4b).
      return 'Not yet queued';
  }
}

// ---------------------------------------------------------------------------
// The shared feed — renders a WorkerTranscriptView through the normal chat's
// AssistantGroup so a watched corp agent looks IDENTICAL to a Pi reply.
// ---------------------------------------------------------------------------

export interface CorpWorkerFeedProps {
  transcript: WorkerTranscriptView | null;
  /** The node is actually running right now (drives running/tail states). */
  working: boolean;
  loading: boolean;
  /** The node's chart state, for the honest empty line. */
  nodeState: OrgNodeView['state'];
  /** Open a file step (read/edit) in the canvas — wired by the inline chat stream
   * to the live corp-peek file view. Omitted where there's no canvas (demo/pane). */
  onOpenFile?: (path: string) => void;
  /** Elapsed working millis of a FINISHED node — renders the "finished in Nm Ns"
   * line (Point 4c). Omitted for a running/queued node or when timing is unknown. */
  finishedInMs?: number;
}

/** The live feed body: briefing card + the streamed AssistantGroup + tail. */
export function CorpWorkerFeed({
  transcript,
  working,
  loading,
  nodeState,
  onOpenFile,
  finishedInMs,
}: CorpWorkerFeedProps) {
  const hasLines = transcript !== null && transcript.lines.length > 0;
  // A finished subagent (spec §11): "subagent finished in Nm Ns" under its stream.
  const finished = (nodeState === 'done' || nodeState === 'retired') && finishedInMs !== undefined;
  // The node's activity as ONE streamed assistant group (the normal chat's shape).
  const view =
    hasLines && transcript !== null ? transcriptToAssistantView(transcript, working) : null;

  // Anti-void tail: a SETTLED answer paragraph while the node is still working
  // shows no live indicator of its own (the chains/thoughts have collapsed), so
  // name the node's current action beneath it — the only case AssistantGroup
  // doesn't already surface a live tail (streaming text / a shimmering step).
  const lastLine = transcript?.lines[transcript.lines.length - 1];
  const settledTextTail =
    lastLine !== undefined &&
    (lastLine.kind === 'message' || lastLine.kind === 'note') &&
    lastLine.streaming !== true;
  const currentAction = transcript?.currentAction;

  return (
    <Thread>
      {transcript !== null ? (
        <TaskBriefingBubble briefing={transcript.briefing} collapsible />
      ) : null}
      {view !== null ? (
        <MessageRow kind="assistant">
          <AssistantGroup
            group={view.group}
            resultByCallId={view.resultByCallId}
            runningToolCalls={[]}
            tps={undefined}
            {...(onOpenFile !== undefined ? { onOpenFile } : {})}
          />
        </MessageRow>
      ) : null}
      {working && hasLines && settledTextTail && currentAction !== undefined ? (
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
      {finished && finishedInMs !== undefined ? (
        <div className="pd-workerpane-finished" data-testid="corp-finished-line">
          Subagent finished in {formatDuration(finishedInMs)}
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
