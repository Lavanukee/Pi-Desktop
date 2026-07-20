/**
 * Harness surfacing:
 *
 *  - {@link ThreadStatusIndicator} — the ONE live status indicator (jedd
 *    blind-test #1). Rendered in the thread only, it reads "Thinking" while the
 *    model reasons and "Working" while it acts, with the harness lifecycle stage
 *    (classifying/reviewing/verifying/…) folded in subtly as a muted detail word.
 *    It replaces the old trio — the duplicate thread working-label, the composer
 *    footer HarnessStatusCluster, and the "switching…" pill — with a single
 *    element, so there is exactly one place that shows run status.
 *  - {@link HarnessChecklistPanel} — the live task checklist the model maintains
 *    via the `update_plan` tool, pinned above the thread so the user watches items
 *    flip pending → in_progress → done with the TaskChecklist animation.
 */
import {
  ContextGauge,
  TaskChecklist,
  type TaskChecklistItem,
  type TaskState,
} from '@pi-desktop/ui';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useLlmStore } from '../state/llm-store';
import { usePiStore } from '../state/pi-slice';
import {
  type PlanItem,
  PREFILL_STATUS_KEY,
  parsePrefillPercent,
  useHarnessStatus,
} from './harness-status';

/** A plan longer than this starts collapsed so it doesn't crowd the thread. */
const LONG_PLAN_THRESHOLD = 6;

/** Map a plan item's status (+ roadmap flag) to a TaskChecklist state. */
function toTaskState(item: PlanItem): TaskState {
  if (item.roadmap === true && item.status !== 'done') return 'roadmap';
  if (item.status === 'in_progress') return 'in-progress';
  if (item.status === 'done') return 'done';
  return 'pending';
}

/**
 * The processing ring (jedd): a context-gauge-style circle that FILLS with the
 * prompt-ingest percent, next to a shimmering "N% processing" label (same sweep
 * as the old working/thinking text). Indeterminate (a soft pulse) while the model
 * loads or before the first prefill frame; the arc fills smoothly as % climbs
 * (the ContextGauge arc already transitions). At 100% it holds full, then the
 * whole thing fades out (see {@link ThreadStatusIndicator}).
 */
function ProcessingRing({
  percent,
  label,
  fading,
}: {
  percent: number | null;
  label: string;
  fading: boolean;
}): ReactElement {
  const value = percent === null ? 0 : Math.min(1, Math.max(0, percent / 100));
  const text = percent === null ? label.toLowerCase() : `${Math.round(percent)}% ${label.toLowerCase()}`;
  return (
    <div
      className={`pd-processing${fading ? ' pd-processing--fading' : ''}`}
      data-testid="thread-processing"
    >
      <ContextGauge
        value={value}
        size={15}
        className={`pd-processing-ring${percent === null ? ' pd-processing-ring--indeterminate' : ''}`}
        label={text}
      />
      <span className="pd-working-label">{text}</span>
    </div>
  );
}

/**
 * The ONE live status indicator. During the PROCESSING phase — from the instant
 * the message is sent (server load / dispatch) through prefill, before the first
 * token — it shows the {@link ProcessingRing}. Once the model starts producing
 * (thinking/tokens stream on their own), the ring fills to 100% and fades. The
 * old "Working · Reviewing · Ns" label is gone (jedd) — the streamed content and
 * inline tool rows carry the run from there. Renders nothing when idle.
 */
export function ThreadStatusIndicator(): ReactElement | null {
  const isStreaming = usePiStore((s) => s.agent.isStreaming);
  const promptInFlight = usePiStore((s) => s.promptInFlight);
  // Prefill progress rides the generic extensionStatus channel (published by the
  // inference lane from provider-llamacpp's `prompt_progress` frames).
  const prefillRaw = usePiStore((s) => s.extensionStatus[PREFILL_STATUS_KEY]);
  const serverStarting = useLlmStore((s) => s.status.phase === 'starting');
  const prefillPct = parsePrefillPercent(prefillRaw);

  // Processing spans send → dispatch (promptInFlight) → prefill (prefillPct). Once
  // the model is generating (no prefill, streaming tokens), it's done processing.
  const processing = promptInFlight || prefillPct !== null;

  // Smooth, capped tick-up (jedd): the raw prefill % can jump 0→100 instantly on a
  // short prompt, then sit at 100 for the (silent) thinking/first-token gap before
  // fading — a dead 100% + blank. Instead ease a DISPLAYED percent toward a cap
  // (~92) while processing — quick at first, slowing as it approaches — using the
  // real % as a floor so a genuinely slow prefill still shows honest progress. It
  // never reaches 100 until processing ends (the first token is ready), when it
  // snaps full and fades.
  const [display, setDisplay] = useState(0);
  const [fading, setFading] = useState(false);
  const wasProcessing = useRef(false);
  useEffect(() => {
    if (processing) {
      wasProcessing.current = true;
      setFading(false);
      const id = setInterval(() => {
        setDisplay((prev) => {
          const floor = prefillPct ?? 0;
          const target = Math.max(floor, 92); // asymptote toward the cap
          const next = prev + (target - prev) * 0.18 + 0.6;
          return Math.min(92, Math.max(prev, next));
        });
      }, 55);
      return () => clearInterval(id);
    }
    if (!wasProcessing.current) return;
    wasProcessing.current = false;
    setDisplay(100); // snap full the instant the model starts producing
    setFading(true);
    const t = setTimeout(() => {
      setFading(false);
      setDisplay(0);
    }, 450);
    return () => clearTimeout(t);
  }, [processing, prefillPct]);

  if (!processing && !fading) return null;
  // During a cold model LOAD there is no real percent — show the indeterminate
  // pulse (null) + "Loading model"; once we're ingesting the prompt, show the
  // climbing "N% processing"; on completion, the full 100% before the fade.
  const percent = processing ? (serverStarting ? null : display) : 100;
  return (
    <ProcessingRing
      percent={percent}
      label={serverStarting ? 'Loading model' : 'Processing'}
      fading={fading}
    />
  );
}

/**
 * The live task checklist, pinned above the thread. Renders nothing until the
 * model publishes a plan via `update_plan`.
 */
export function HarnessChecklistPanel() {
  const status = useHarnessStatus();
  const plan = status?.plan;
  if (plan === undefined || plan === null || plan.length === 0) return null;

  const items: TaskChecklistItem[] = plan.map((p) => ({ label: p.text, state: toTaskState(p) }));

  return (
    <div className="mx-auto w-full max-w-[700px] px-4 pt-2" data-testid="harness-checklist">
      <TaskChecklist
        className="border border-border-subtle bg-surface-raised"
        title={status?.planTitle ?? 'Plan'}
        items={items}
        // Round-14 #6: the pinned panel collapses to just its title header so a
        // long plan can tuck up out of the way. Long plans start collapsed.
        collapsible
        defaultCollapsed={items.length > LONG_PLAN_THRESHOLD}
      />
    </div>
  );
}
