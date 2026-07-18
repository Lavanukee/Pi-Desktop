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
import { useCanvasTabs } from '@pi-desktop/canvas';
import type {
  OrgNodeView,
  WorkerBriefingView,
  WorkerTranscriptLine,
  WorkerTranscriptView,
} from '@pi-desktop/coordination';
import { useCallback, useEffect, useState } from 'react';
import { fetchWorkerTranscript } from '../../state/corp-connect';
import { type CorpBlock, useCorpStore } from '../../state/corp-store';
import { CorpWorkerFeed } from './CorpWorkerPane';
import { corpFileTabKey, openCorpFileInCanvas } from './corp-file-canvas';
import './CorpChatStream.css';

/** Fallback poll cadence (a pinned node with no pushed deltas): fast while the
 * polled transcript still streams, calm otherwise. The live node never polls. */
const POLL_MS = 900;
const POLL_STREAMING_MS = 120;

export interface CorpChatStreamProps {
  taskId: string;
  /** The agent whose live stream to show (follow-live target, or a pinned pick). */
  node: OrgNodeView;
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

export function CorpChatStream({ taskId, node }: CorpChatStreamProps) {
  const blocks = useCorpStore((s) => s.workerBlocks[node.id]);
  const liveBlocks = blocks ?? [];
  const hasPush = liveBlocks.length > 0;
  const working = node.state === 'working';
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
  }, [taskId, node.id, working]);

  // Open a file step in the canvas as a LIVE corp-peek view (owner's bar (b)).
  const openFile = useCallback(
    (path: string) => {
      void openCorpFileInCanvas(controller, taskId, path, node.state === 'working');
    },
    [controller, taskId, node.state],
  );

  // Auto-refresh an ALREADY-OPEN corp file tab as its +N/−N grow (the active write
  // updates live in the canvas). Keyed on the file blocks' signature so it fires
  // only when a file row changes — never on every streamed text token.
  const fileSig = liveBlocks
    .filter((b): b is Extract<CorpBlock, { kind: 'file' }> => b.kind === 'file')
    .map((b) => `${b.path}:${b.addedLines}:${b.removedLines}`)
    .join('|');
  useEffect(() => {
    if (fileSig === '') return;
    const openKeys = new Set(controller.getState().tabs.map((t) => t.key));
    const current = useCorpStore.getState().workerBlocks[node.id] ?? [];
    for (const b of current) {
      if (b.kind === 'file' && openKeys.has(corpFileTabKey(b.path))) {
        void openCorpFileInCanvas(controller, taskId, b.path, node.state === 'working');
      }
    }
  }, [fileSig, controller, taskId, node.id, node.state]);

  // The live body: the shown node's accumulated blocks (PUSH), rendered through the
  // shared feed. NO currentAction is threaded — the pushed streaming blocks ARE the
  // live tail, so the feed never shows a bare "Responding/working…" void. When there
  // are no pushed deltas yet, fall back to the polled transcript.
  const view: WorkerTranscriptView | null = hasPush
    ? {
        nodeId: node.id,
        role: transcript?.role ?? node.role,
        briefing: transcript?.briefing ?? synthBriefing(node),
        lines: liveBlocks.map((b) => blockToLine(b, working)),
        ...(working &&
        liveBlocks.some((b) => (b.kind === 'text' || b.kind === 'thinking') && b.streaming)
          ? { streaming: true }
          : {}),
      }
    : transcript;

  return (
    <div className="pd-corpchat-stream" data-testid="corp-chat-stream" data-node-id={node.id}>
      <CorpWorkerFeed
        transcript={view}
        working={working}
        loading={loading && !hasPush}
        nodeState={node.state}
        onOpenFile={openFile}
      />
    </div>
  );
}
