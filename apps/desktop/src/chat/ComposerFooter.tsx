/**
 * Composer footer cluster: current-model chip (with a menu that switches pi
 * models and downloads/starts local ones), live TPS from the inference
 * supervisor, and a context-fullness gauge. When nothing is set up it shows a
 * tasteful "pick a model" affordance that kicks off a download (full model
 * manager is W10).
 */
import type { ChatMsg, Model, Usage } from '@pi-desktop/engine';
import {
  Button,
  ContextGauge,
  ContextGaugeTooltip,
  IconButton,
  IconChevronDown,
  IconInfo,
  IconSparkles,
  ProgressBar,
  Spinner,
  Tooltip,
} from '@pi-desktop/ui';
// Harness SOURCE import (not the barrel) — keeps the renderer bundle clean; see
// auto-router.ts. tier.ts is pure + browser-safe.
import { TIER_LABEL } from '../../../../packages/harness/src/classify/tier.ts';
import { useLlmStore } from '../state/llm-store';
import { selectionTier } from '../state/model-selection';
import { useModelSwitching } from '../state/model-selection-store';
import { usePiStore } from '../state/pi-slice';
import { useModelSelection, useUserMode } from '../state/settings-store';
import { AutoDownloadPrompt } from './AutoDownloadPrompt';
import { chipLabel } from './footer-models';
import { HarnessStatusCluster } from './HarnessStatus';
import { TierPickerMenu } from './TierPickerMenu';

/** 73000 → "73,000"; small numbers pass through. */
function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function fmtPct(part: number, whole: number): string | null {
  if (whole <= 0) return null;
  return `${Math.round((part / whole) * 100)}%`;
}

function fmtElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 1) return `${Math.round(ms)}ms`;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

interface TurnStats {
  usage: Usage | undefined;
  toolCalls: number;
  /** Wall-clock span of the last turn, derived from message timestamps. */
  elapsedMs: number | undefined;
}

/**
 * Derive the current/last turn's stats from the store messages. "Last turn" is
 * everything from the most recent user message to the end (its assistant
 * response + interleaved tool results). Usage/tokens are the engine's real
 * numbers; the tool-call count is exact; the elapsed span is derived from
 * client-side message timestamps (labelled as such in the popover).
 */
function deriveTurnStats(messages: ChatMsg[]): TurnStats {
  let userIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.kind === 'user') {
      userIdx = i;
      break;
    }
  }
  const turn = userIdx >= 0 ? messages.slice(userIdx) : messages;
  let usage: Usage | undefined;
  let toolCalls = 0;
  let startTs: number | undefined;
  let endTs: number | undefined;
  for (const m of turn) {
    if (startTs === undefined || m.timestamp < startTs) startTs = m.timestamp;
    if (endTs === undefined || m.timestamp > endTs) endTs = m.timestamp;
    if (m.kind === 'assistant') {
      if (m.usage !== undefined) usage = m.usage;
      for (const b of m.blocks) if (b.type === 'toolCall') toolCalls++;
    }
  }
  const elapsedMs =
    startTs !== undefined && endTs !== undefined ? Math.max(0, endTs - startTs) : undefined;
  return { usage, toolCalls, elapsedMs };
}

/** A labelled row in the stats popover. */
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center justify-between gap-6">
      <span className="text-text-muted">{label}</span>
      <span className="text-text-primary tabular-nums">{value}</span>
    </span>
  );
}

export function ComposerFooter({
  piModels,
  onOpenModels,
}: {
  piModels: Model[];
  onOpenModels?: () => void;
}) {
  const agentModel = usePiStore((s) => s.agent.model);
  const messages = usePiStore((s) => s.messages);
  const status = useLlmStore((s) => s.status);
  const download = useLlmStore((s) => s.download);
  // Round-12 (W3): the model chip + its picker are mode-aware. The picker itself
  // (Auto + the three capability tiers) is the shared TierPickerMenu; here we
  // only decide the CHIP LABEL from the mode + selection.
  const userMode = useUserMode();
  const selection = useModelSelection();
  const switching = useModelSwitching();
  const activeTier = selectionTier(selection);
  const isAuto = selection.mode === 'auto';

  // Round-14 (#4): mode-aware chip label — power shows the raw model name; user
  // mode names the selection ("Auto" / a tier label / a pinned model), never the
  // raw model id under a tier. Falls back to a "pick a model" affordance.
  const label =
    chipLabel(
      userMode,
      selection,
      activeTier,
      agentModel?.name ?? status.model?.displayName ?? null,
    ) ?? (piModels.length > 0 ? 'Choose model' : 'Pick a model');

  // Context gauge: latest turn's total tokens over the launched window.
  let gauge: number | null = null;
  let usedTokens: number | null = null;
  const contextWindow = status.model?.contextWindow ?? 0;
  for (let i = messages.length - 1; i >= 0 && gauge === null; i--) {
    const m = messages[i];
    if (m?.kind === 'assistant' && m.usage !== undefined && contextWindow > 0) {
      usedTokens = m.usage.totalTokens;
      gauge = Math.min(1, usedTokens / contextWindow);
    }
  }

  const tps = status.metrics?.avgTps ?? status.metrics?.lastTps;

  // Current/last-turn stats for the info popover (round-5 #25).
  const stats = deriveTurnStats(messages);
  const modelName = agentModel?.name ?? status.model?.displayName ?? null;
  const usage = stats.usage;
  const inputPct = usage !== undefined ? fmtPct(usage.input, contextWindow) : null;
  const outputPct = usage !== undefined ? fmtPct(usage.output, contextWindow) : null;

  return (
    <>
      {/* Anchor for the friendly auto-download card, which floats just above the
          model chip when Auto resolves to an un-downloaded tier. */}
      <span className="relative flex items-center">
        <AutoDownloadPrompt />
        {/* The shared tier picker (Auto + the three capability tiers, + a power-mode
            "More models" deep-link). The chip is its trigger. */}
        <TierPickerMenu
          align="start"
          side="top"
          onOpenManager={onOpenModels}
          menuTestId="footer-model-menu"
        >
          <Button variant="ghost" size="sm" className="gap-1" data-testid="footer-model-chip">
            {isAuto ? <IconSparkles size={14} /> : null}
            <span className="max-w-[180px] truncate">{label}</span>
            <IconChevronDown size={16} />
          </Button>
        </TierPickerMenu>
      </span>

      {/* Honest about the (seconds-long) restart when Auto/a tier pick switches
          the running model — a live, always-visible "switching…" pill. */}
      {switching !== null ? (
        <span
          className="flex items-center gap-1 text-footnote text-text-muted"
          data-testid="footer-switching"
        >
          <Spinner size={12} />
          Switching to {TIER_LABEL[switching.toTier]}…
        </span>
      ) : null}

      {download !== null ? (
        <div className="flex w-28 items-center gap-1">
          <ProgressBar value={download.fraction} />
        </div>
      ) : null}

      {tps !== undefined ? (
        <span className="text-footnote text-text-muted" data-testid="tps">
          {tps.toFixed(1)} tok/s
        </span>
      ) : null}

      {/* Harness surfacing (round-9 W3): active class + live task timer + repair
          activity, so all four status elements live in one always-visible cluster. */}
      <HarnessStatusCluster />

      {/* Info popover: current/last-turn stats. Tokens are real (engine usage);
          the tool-call count is exact; elapsed is derived from message
          timestamps (labelled estimated). Hover to reveal (round-5 #25). */}
      <Tooltip
        side="top"
        align="end"
        delayDuration={100}
        className="pd-context-tooltip"
        label={
          <span
            className="flex min-w-[220px] flex-col gap-1.5 text-footnote"
            data-testid="turn-stats"
          >
            <span className="font-medium text-text-primary">Last turn</span>
            {modelName !== null ? <StatRow label="Model" value={modelName} /> : null}
            {usage !== undefined ? (
              <>
                <StatRow
                  label="Input ↓"
                  value={`${fmtInt(usage.input)}${inputPct !== null ? ` · ${inputPct}` : ''}`}
                />
                <StatRow
                  label="Output ↑"
                  value={`${fmtInt(usage.output)}${outputPct !== null ? ` · ${outputPct}` : ''}`}
                />
                <StatRow label="Total" value={fmtInt(usage.totalTokens)} />
              </>
            ) : (
              <StatRow label="Tokens" value="—" />
            )}
            <StatRow label="Tool calls" value={String(stats.toolCalls)} />
            {stats.elapsedMs !== undefined ? (
              <StatRow label="Elapsed*" value={fmtElapsed(stats.elapsedMs)} />
            ) : null}
            <span className="text-text-muted">* estimated from message timestamps</span>
          </span>
        }
      >
        <IconButton size="sm" aria-label="Turn stats" data-testid="footer-info">
          <IconInfo size={16} />
        </IconButton>
      </Tooltip>

      {gauge !== null && usedTokens !== null ? (
        <ContextGaugeTooltip
          percent={Math.round(gauge * 100)}
          usedTokens={usedTokens}
          totalTokens={contextWindow}
          note="Pi automatically compacts its context as it fills up."
        >
          <ContextGauge value={gauge} tone={gauge > 0.85 ? 'warn' : 'muted'} />
        </ContextGaugeTooltip>
      ) : null}
    </>
  );
}
