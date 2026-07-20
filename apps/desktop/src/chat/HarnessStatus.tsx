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
  // Prefill progress rides the generic extensionStatus channel (the REAL
  // processed/total the server reports via provider-llamacpp's `prompt_progress`
  // frames) — no fabricated easing; the ring shows exactly what llama reports.
  const prefillRaw = usePiStore((s) => s.extensionStatus[PREFILL_STATUS_KEY]);
  const serverStarting = useLlmStore((s) => s.status.phase === 'starting');
  const prefillPct = parsePrefillPercent(prefillRaw);
  const messages = usePiStore((s) => s.messages);

  // The CURRENT turn's assistant message while it is STILL EMPTY — i.e. the model
  // has started the turn but not yet produced any content (text / thinking / a
  // tool call). This is the "prefill / pre-first-token" window. It self-clears the
  // instant a token lands (the block gains content) OR the turn ends (the message
  // stops streaming), so — unlike keying off `isStreaming`, which stays true
  // through an ask_user pause or a long multi-step turn — it can never stick.
  const streamingAssistant = messages.find(
    (m) => m.kind === 'assistant' && m.isStreaming === true,
  );
  const streamHasContent =
    streamingAssistant !== undefined &&
    streamingAssistant.kind === 'assistant' &&
    streamingAssistant.blocks.some((b) =>
      b.type === 'text' ? b.text.length > 0 : b.type === 'thinking' ? b.thinking.length > 0 : true,
    );

  // Processing = the send is dispatching (promptInFlight) OR the turn's assistant
  // exists but hasn't produced a token yet. BOTH self-clear (on agent_start /
  // first token), so the ring fades exactly on the first token and can NOT persist
  // into generation. `prefillPct` (a stale value lingers until turn end) drives
  // only the DISPLAYED number, never the show/hide — otherwise a leftover % would
  // keep the ring up during the reply.
  const processing = promptInFlight || (streamingAssistant !== undefined && !streamHasContent);

  // Snap to 100% then fade ONLY once the first token lands (processing → false).
  const [fading, setFading] = useState(false);
  const wasProcessing = useRef(false);
  useEffect(() => {
    if (processing) {
      wasProcessing.current = true;
      setFading(false);
      return;
    }
    if (!wasProcessing.current) return;
    wasProcessing.current = false;
    setFading(true);
    const t = setTimeout(() => setFading(false), 450);
    return () => clearTimeout(t);
  }, [processing]);

  if (!processing && !fading) return null;
  // Cold model LOAD → indeterminate pulse + "Loading model" (no fake %). Ingesting
  // → the REAL prefill % (parsePrefillPercent caps at 99, so it never falsely
  // reads 100 mid-prefill). Completion (first token) → 100 before the fade.
  const percent = processing ? (serverStarting ? null : prefillPct) : 100;
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
