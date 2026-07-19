/**
 * The corp run's LIVE MODEL OUTPUT, rendered inline in the chat as the assistant's
 * answer — streamed PER TOKEN, exactly like the normal Pi chat. The shown agent's
 * per-node deltas are PUSHED onto the coordination stream as `worker-activity`
 * events, folded into a block accumulator (corp-store), and rendered here through
 * the SAME components the normal chat uses — Markdown for text (re-rendered per
 * delta = smooth), the collapsible thinking block (collapsible even mid-thought),
 * and the ActivityChain for tool + file rows — via the shared {@link CorpWorkerFeed}.
 * A live file edit shows +N/−N counting up as the engine reports line deltas, and
 * clicking it opens that file live in the canvas peek.
 *
 * NO polling for the live node: its body streams straight from the pushed
 * accumulator. Polling remains ONLY as the fallback for a pinned, non-live node
 * with no buffered deltas (and a one-shot fetch sources the briefing).
 */
import { type CanvasTabSpec, nodeElapsedMs, useCanvasTabs } from '@pi-desktop/canvas';
import type {
  OrgNodeView,
  WorkerBriefingView,
  WorkerTranscriptLine,
  WorkerTranscriptView,
} from '@pi-desktop/coordination';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCanvasStore } from '../../state/canvas-store';
import { fetchWorkerTranscript } from '../../state/corp-connect';
import { type CorpBlock, useCorpStore } from '../../state/corp-store';
import { type DetectedArtifact, toCanvasArtifact } from '../canvas/artifacts';
import { CorpWorkerFeed } from './CorpWorkerPane';
import { corpArtifacts } from './corp-blocks';
import { openCorpFileInCanvas } from './corp-file-canvas';
import './CorpChatStream.css';

/** Fallback poll cadence (a pinned node with no pushed deltas): fast while the
 * polled transcript still streams, calm otherwise. The live node never polls. */
const POLL_MS = 900;
const POLL_STREAMING_MS = 120;

/** After this long with no stream delta while the node is still working, the model
 * is PROCESSING (prefilling the prompt, or blocked on a slow tool) — the J1
 * "Processing… Ns" indicator stands in so the gap never reads as a frozen frame.
 * Matches the dev HUD's stall threshold (CorpDebugHud). */
const PROCESSING_STALL_MS = 2500;
/** How often the processing clock ticks while a node is working (HUD cadence). */
const PROCESSING_TICK_MS = 250;
/** Stable empty ref so an idle render never re-triggers the artifact-routing effect. */
const NO_ARTIFACTS: DetectedArtifact[] = [];

/**
 * A cheap content signature that grows whenever ANY block's text / output / line
 * counts grow — a change marks a fresh stream delta. When it stops growing while
 * the node is still working, the elapsed gap IS the processing time (the same
 * signal the dev HUD's stall detector reads).
 */
function blocksSignature(blocks: readonly CorpBlock[]): number {
  let n = blocks.length;
  for (const b of blocks) {
    if (b.kind === 'text' || b.kind === 'thinking') n += b.text.length;
    else if (b.kind === 'tool') n += (b.detail?.length ?? 0) + (b.output?.length ?? 0);
    else n += b.addedLines + b.removedLines;
  }
  return n;
}

export interface CorpChatStreamProps {
  taskId: string;
  /** The agent whose live stream to show (follow-live target, or a pinned pick). */
  node: OrgNodeView;
  /**
   * History mode (A3): render the node's already-produced blocks as SETTLED chat
   * history — no live "Working…"/waiting tail of its own. Used to KEEP the CEO's
   * vision-forming turn visible above the live "Waiting for N…" indicator once the
   * team forms, so the vision never vanishes on promotion. Renders nothing when
   * the node has no pushed output to preserve.
   */
  historyMode?: boolean;
}

/** Poll-burst dedupe (the worker pane's rule): a snapshot that shows nothing new
 * must not re-render the fallback feed. Compares the growth surface. */
function sameSnapshot(prev: WorkerTranscriptView, next: WorkerTranscriptView): boolean {
  if (prev.nodeId !== next.nodeId || prev.lines.length !== next.lines.length) return false;
  if (prev.streaming !== next.streaming || prev.currentAction !== next.currentAction) return false;
  const a = prev.lines[prev.lines.length - 1];
  const b = next.lines[next.lines.length - 1];
  return a?.text === b?.text && a?.streaming === b?.streaming;
}

/**
 * A pushed {@link CorpBlock} → the transcript line the shared {@link CorpWorkerFeed}
 * renders. The live flag is gated on `working` so a settled node never shows a
 * spinning tail (streaming text folds to a plain message, a live thought to a
 * collapsed "Thought" step).
 */
function blockToLine(block: CorpBlock, working: boolean): WorkerTranscriptLine {
  switch (block.kind) {
    case 'text':
      return {
        at: 0,
        kind: 'message',
        text: block.text,
        ...(block.streaming && working ? { streaming: true } : {}),
      };
    case 'thinking':
      return {
        at: 0,
        kind: 'thinking',
        text: block.text,
        ...(block.streaming && working ? { streaming: true } : {}),
      };
    case 'tool':
      return {
        at: 0,
        kind: 'tool-call',
        text: block.toolName,
        ...(block.label !== undefined ? { label: block.label } : {}),
        ...(block.detail !== undefined ? { detail: block.detail } : {}),
        ...(block.path !== undefined ? { path: block.path } : {}),
      };
    case 'file':
      return {
        at: 0,
        kind: 'file-touch',
        text: `writing ${block.path}`,
        path: block.path,
        label: block.label ?? 'Writing',
        addedLines: block.addedLines,
        ...(block.removedLines > 0 ? { removedLines: block.removedLines } : {}),
      };
  }
}

/** A minimal briefing shown before the real one is fetched — honest + generic. */
function synthBriefing(node: OrgNodeView): WorkerBriefingView {
  const lead = node.role === 'ceo' || node.role === 'solo';
  return {
    workerName: node.name,
    roleLine: lead ? 'Lead' : 'Builder',
    title: node.name,
    goal: lead ? 'Answering — forming the plan.' : `Live work by ${node.name}.`,
    deliverables: [],
  };
}

export function CorpChatStream({ taskId, node, historyMode = false }: CorpChatStreamProps) {
  const blocks = useCorpStore((s) => s.workerBlocks[node.id]);
  const situation = useCorpStore((s) => s.situation);
  const liveBlocks = blocks ?? [];
  const hasPush = liveBlocks.length > 0;
  // J4: the lead (CEO/root) keeps STREAMING through the vision→promotion hand-off.
  // History mode used to force `working` off, so the lead's post-vision tool calls
  // (submit_vision → create_production_hierarchy) rendered as dead settled rows
  // beneath a bare header. Now the feed stays live while the node is `working` — its
  // thoughts/tool-calls stream continuously — and only its own idle "Working…" tail
  // is suppressed in history mode (the sibling "Waiting for N…" indicator carries
  // the coordinating signal). It settles to plain history once the lead stops.
  const working = node.state === 'working';
  // A finished node shows "subagent finished in Nm Ns" — its frozen working span
  // (finishedAt − startedAt; `now` is ignored once finishedAt is set).
  const timing = useCorpStore((s) => s.nodeTiming[node.id]);
  const finished = node.state === 'done' || node.state === 'retired';
  const finishedInMs = finished ? nodeElapsedMs(timing, Date.now()) : undefined;
  const [transcript, setTranscript] = useState<WorkerTranscriptView | null>(null);
  const [loading, setLoading] = useState(true);
  const { controller } = useCanvasTabs();

  // Fetch the node's transcript for its BRIEFING (+ the fallback body). While the
  // node has NO pushed deltas we POLL (the pinned-non-live fallback) fast-while-
  // streaming, calm otherwise; the moment pushed deltas exist we STOP polling — the
  // live node streams via PUSH — keeping the last fetch only for its briefing.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // History mode needs no transcript (the briefing is suppressed for a lead and
    // the body comes from the pushed blocks) — skip the poll entirely.
    if (historyMode) {
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const pull = () => {
      void fetchWorkerTranscript(taskId, node.id).then((t) => {
        if (cancelled) return;
        setLoading(false);
        if (t !== null) {
          setTranscript((prev) => (prev !== null && sameSnapshot(prev, t) ? prev : t));
        }
        // Live node (pushed deltas exist) → no polling. Settled + not streaming → stop.
        if ((useCorpStore.getState().workerBlocks[node.id]?.length ?? 0) > 0) return;
        if (!working && !(t?.streaming === true)) return;
        timer = setTimeout(pull, t?.streaming === true ? POLL_STREAMING_MS : POLL_MS);
      });
    };
    pull();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [taskId, node.id, working, historyMode]);

  // Open a file step in the canvas as a LIVE corp-peek view (owner's bar (b)).
  const openFile = useCallback(
    (path: string) => {
      void openCorpFileInCanvas(controller, taskId, path, node.state === 'working');
    },
    [controller, taskId, node.state],
  );

  // The live file tab (its streaming content + its +N/−N badge) is driven entirely
  // by the corp→canvas routing hook (useCorpCanvasRouting) off the SAME store, so
  // there is no per-node refresh here — that path stole focus + could clobber the
  // live write body with an empty product-peek read. Clicking a file row still
  // opens it on demand via `openFile` below.

  // Is the node producing output RIGHT NOW (a streaming text/thinking tail)?
  const anyStreaming = liveBlocks.some(
    (b) => (b.kind === 'text' || b.kind === 'thinking') && b.streaming,
  );

  // J1: the user-facing "Processing…" detector — the equivalent of the dev HUD's
  // stall detector, but in the chat. While the node is working but no token has
  // streamed for a beat (a prefill / slow-tool gap), surface a live "Processing… Ns"
  // indicator beneath the latest step so the gap never reads as a frozen frame.
  // `sig` grows on every delta; when it stops while working, the gap is the
  // processing time. Scoped to the LIVE stream (a pinned/pre-promotion node) — the
  // promoted lead's history view defers to its shimmering tool call + the
  // "Waiting for N…" indicator.
  //
  // TODO(progress): a true "N% done" needs the llama server's prompt-eval progress,
  // which the OpenAI-style stream doesn't expose during prefill. When the corp
  // stream emits a prompt-eval progress signal, show the % here; until then, the
  // placement + elapsed seconds ship now.
  const sig = blocksSignature(liveBlocks);
  const lastDeltaAt = useRef(Date.now());
  const [nowTick, setNowTick] = useState(() => Date.now());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `sig` is the delta signal
  useEffect(() => {
    lastDeltaAt.current = Date.now();
  }, [sig]);
  useEffect(() => {
    if (!working || historyMode) return undefined;
    const id = setInterval(() => setNowTick(Date.now()), PROCESSING_TICK_MS);
    return () => clearInterval(id);
  }, [working, historyMode]);
  const sinceDelta = nowTick - lastDeltaAt.current;
  const processing =
    working && !historyMode && hasPush && !anyStreaming && sinceDelta > PROCESSING_STALL_MS;
  const processingSeconds = processing ? Math.floor(sinceDelta / 1000) : undefined;

  // B3: the anti-void tail for a working node with nothing streaming. A coordinator
  // LEAD (ceo/manager/division-head) in a PROMOTED run is not producing — it's
  // waiting on its team — so it reads that way instead of a bare "Working…" that
  // looks like a stall when the user is watching a non-acting node. Pre-promotion
  // the lead IS the sole worker forming the vision, so "Working…" is honest.
  const promoted = (situation?.chart.nodes.length ?? 0) > 1;
  const coordinatorLead =
    node.role === 'ceo' || node.role === 'manager' || node.role === 'division-head';
  const idleTail =
    promoted && coordinatorLead ? 'waiting for other subagents to finish' : 'Working…';

  // The live body: the shown node's accumulated blocks (PUSH), rendered through the
  // shared feed. When the node is working but NOTHING is streaming (the inter-turn
  // gap between one turn ending and the next starting), thread a live "Working…"
  // action so the feed's anti-void tail shows a working indicator beneath the last
  // settled paragraph — there is ALWAYS streaming text, a live edit, or "Working…",
  // never a frozen frame. While something streams, the streaming tail IS the live
  // signal, so no indicator is threaded. Falls back to the polled transcript when
  // there are no pushed deltas yet.
  const view: WorkerTranscriptView | null = hasPush
    ? {
        nodeId: node.id,
        role: transcript?.role ?? node.role,
        briefing: transcript?.briefing ?? synthBriefing(node),
        lines: liveBlocks.map((b) => blockToLine(b, working)),
        ...(working && anyStreaming ? { streaming: true } : {}),
        // J4: history mode suppresses the lead's OWN idle tail (the "Waiting for
        // N…" indicator carries the coordinating signal); the live stream still
        // streams its thoughts/tool-calls through the promotion.
        ...(working && !anyStreaming && !historyMode ? { currentAction: idleTail } : {}),
      }
    : transcript;

  // J3: detect the THEME-2 inline artifacts (```html/```svg) the shown node wrote
  // and route each to a CANVAS tab — the corp feed suppresses them inline (owner
  // rule), so a mockup.html preview opens in the canvas, never as a black box in
  // the chat. Open once (bringing the canvas forward), quiet-refresh on growth, and
  // never reopen a user-closed one. Keyed on a content signature so the routing
  // effect fires on real changes, not every processing tick.
  const artifacts = view !== null ? corpArtifacts(view.lines, working) : NO_ARTIFACTS;
  const artifactSig = artifacts.map((a) => `${a.id}:${a.text.length}`).join('|');
  const openedArtifacts = useRef<Set<string>>(new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `artifactSig` is the change signal for `artifacts`
  useEffect(() => {
    for (const a of artifacts) {
      const spec: CanvasTabSpec = {
        kind: a.kind,
        key: a.id,
        title: a.title,
        artifact: toCanvasArtifact(a),
      };
      const existing = controller.getState().tabs.find((t) => t.key === a.id);
      if (existing === undefined) {
        if (openedArtifacts.current.has(a.id)) continue; // user closed it — leave it
        openedArtifacts.current.add(a.id);
        controller.upsertTab(a.id, spec);
        useCanvasStore.getState().setCanvasOpen(true);
      } else if (existing.artifact?.content.text !== a.text) {
        controller.updateTab(existing.id, { artifact: spec.artifact, title: spec.title });
      }
    }
  }, [artifactSig, controller]);

  // A3: in history mode with nothing to preserve, render nothing (the live
  // "Waiting for N…" indicator alongside carries the signal).
  if (historyMode && !hasPush) return null;

  return (
    <div className="pd-corpchat-stream" data-testid="corp-chat-stream" data-node-id={node.id}>
      <CorpWorkerFeed
        transcript={view}
        working={working}
        loading={loading && !hasPush}
        nodeState={node.state}
        onOpenFile={openFile}
        {...(processingSeconds !== undefined ? { processingSeconds } : {})}
        {...(finishedInMs !== undefined ? { finishedInMs } : {})}
      />
    </div>
  );
}
