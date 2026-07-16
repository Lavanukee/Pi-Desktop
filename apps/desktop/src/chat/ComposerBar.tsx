/**
 * ComposerBar (round-12 W2, jedd #6) — the thin "sticking-out" bar fused to the
 * bottom edge of the input card and protruding below it. Two regions pushed to
 * opposite ends by an empty flex spacer in the middle:
 *   LEFT   — the active-folder (project) button, relocated here from above the
 *            composer and slimmed (reuses the canvas ProjectPicker verbatim).
 *   CENTER — an empty flex spacer (round-15): the routed tier now lives entirely
 *            on the footer model chip ("Auto · <tier>"), so the bar no longer
 *            renders a center tier control.
 *   RIGHT  — the context-fullness ring (round-A #5, moved here from the input-bar
 *            footer so it sits just LEFT of Effort) followed by the "Effort"
 *            button; the effort SLIDER (blue→hot temperature pill) opens in a
 *            popover (round-14 #2). The button reads the labeled "Effort · <Level>"
 *            ("Effort · Balanced" by default, mirroring the model chip); a drag
 *            pins an explicit level (max only reachable by an explicit drag).
 *
 * Reads harness status (`useHarnessStatus`), the project store, and settings;
 * writes effort through the existing settings-store `update` (which persists +
 * pushes `/harness effort`). Imports the tier/effort mapping — it does not
 * redefine it (state/model-selection + composer-bar-logic own that).
 */
import { ProjectPicker } from '@pi-desktop/canvas';
import {
  ContextGauge,
  ContextGaugeTooltip,
  EffortSlider,
  IconGauge,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@pi-desktop/ui';
import { useLlmStore } from '../state/llm-store';
import { autoEffortForTier } from '../state/model-selection';
import { usePiStore } from '../state/pi-slice';
import { useProjectStore } from '../state/project-store';
import { useEffortMode, useSettingsStore } from '../state/settings-store';
import {
  EFFORT_STEP_COUNT,
  effortSliderView,
  levelForIndex,
  resolveContextGauge,
  usesSandbox,
} from './composer-bar-logic';
import { useHarnessStatus } from './harness-status';

/** LEFT: the relocated project (working-folder) chip, slimmed for the bar. When
 * the selected project folder is MISSING and pi fell back to the conversation
 * sandbox, the chip drops the stale name for a subtle "Sandbox" warn state
 * (jedd #13) instead of pretending the dead folder is the working dir. */
function ProjectRegion() {
  const projects = useProjectStore((s) => s.projects);
  const activeId = useProjectStore((s) => s.activeId);
  const activePath = useProjectStore((s) => s.activePath);
  // jedd #6: drive the sandbox/"No project" chip off the STORE FLAG, not a stale
  // folder name. The project store already tracks `projectMissing` (the selected
  // project's folder is gone on disk → pi ran in the conversation sandbox); the
  // CRITICAL wave may also expose an explicit `usingSandbox`. Prefer the explicit
  // flag, fall back to `projectMissing`, and only then to the session-cwd sniff.
  const projectMissing = useProjectStore((s) => s.projectMissing);
  const sandboxFlag = useProjectStore(
    (s) => (s as unknown as { usingSandbox?: boolean }).usingSandbox,
  );
  const sessionCwd = usePiStore((s) => s.session?.cwd);
  const selectProject = useProjectStore((s) => s.selectProject);
  const newProject = useProjectStore((s) => s.newProject);
  const clearProject = useProjectStore((s) => s.clearProject);

  const sandbox = usesSandbox(activePath, sessionCwd, sandboxFlag ?? projectMissing);
  const className = ['pd-project-picker--bar', sandbox ? 'pd-project-picker--sandbox' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <ProjectPicker
      className={className}
      projects={projects.map((p) => ({ id: p.id, name: p.name }))}
      // In the sandbox we're NOT in the selected project, so don't render its name
      // as the active working folder — fall through to the "Sandbox" placeholder.
      active={sandbox ? null : activeId}
      onSelect={(id) => void selectProject(id)}
      onNew={() => void newProject()}
      onClear={() => void clearProject()}
      placeholder={sandbox ? 'Sandbox' : 'No project'}
    />
  );
}

/**
 * RIGHT, left of Effort: the context-fullness ring (round-A #5). Relocated off the
 * input-bar footer to sit just LEFT of the Effort control. Prefers pi's OWN
 * per-turn context accounting (`HarnessStatus.contextPercent`, from
 * `ctx.getContextUsage()`) — which updates on every provider (local llama /
 * remote / AFM) — and only falls back to the launched-window token math when the
 * harness hasn't reported a percent yet. This is why the ring is no longer stuck.
 */
function ContextRegion() {
  const messages = usePiStore((s) => s.messages);
  const contextWindow = useLlmStore((s) => s.status.model?.contextWindow ?? 0);
  const contextPercent = useHarnessStatus()?.contextPercent;
  const gauge = resolveContextGauge({ contextPercent, messages, contextWindow });
  if (gauge === null) return null;
  return (
    <ContextGaugeTooltip
      percent={Math.round(gauge.value * 100)}
      usedTokens={gauge.usedTokens}
      totalTokens={contextWindow}
      note="Pi automatically compacts its context as it fills up."
    >
      <ContextGauge value={gauge.value} tone={gauge.value > 0.85 ? 'warn' : 'muted'} />
    </ContextGaugeTooltip>
  );
}

/** RIGHT: the "Effort" button that opens the effort slider in a popover. */
function EffortRegion() {
  const status = useHarnessStatus();
  const activeTier = status?.activeTier ?? null;
  const effortMode = useEffortMode();
  const effort = useSettingsStore((s) => s.settings.effort);
  const view = effortSliderView(effortMode, effort, activeTier);

  // Dragging/keying to a detent pins an explicit level; the Auto affordance
  // returns to auto, resolving the tier's level so the harness runs it now.
  // Both go through the store's `update` (persist + `/harness effort`).
  const onLevelChange = (index: number): void => {
    void useSettingsStore.getState().update({ effortMode: 'level', effort: levelForIndex(index) });
  };
  const onAuto = (): void => {
    const patch =
      activeTier !== null
        ? { effortMode: 'auto' as const, effort: autoEffortForTier(activeTier) }
        : { effortMode: 'auto' as const };
    void useSettingsStore.getState().update(patch);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="pd-effort-trigger"
          data-testid="composer-effort"
          aria-label="Effort"
        >
          <IconGauge size={14} />
          <span>{view.label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="pd-menu--instant pd-effort-popover"
        side="top"
        align="end"
        sideOffset={8}
        // jedd #14: land the popover's initial focus on the slider thumb (not the
        // "?" help button) so arrow keys nudge effort immediately. The help button
        // is already out of the tab order (EffortSlider), but focus the track
        // explicitly for determinism across Radix focus-scope versions.
        onOpenAutoFocus={(e) => {
          const root = e.currentTarget as HTMLElement | null;
          const slider = root?.querySelector<HTMLElement>('[role="slider"]');
          if (slider !== null && slider !== undefined) {
            e.preventDefault();
            slider.focus();
          }
        }}
      >
        <EffortSlider
          steps={EFFORT_STEP_COUNT}
          value={view.index}
          fill={view.fill}
          auto={view.auto}
          label={view.label}
          valueText={view.valueText}
          onLevelChange={onLevelChange}
          onAuto={onAuto}
          data-testid="composer-effort-slider"
        />
      </PopoverContent>
    </Popover>
  );
}

export function ComposerBar() {
  return (
    <div className="pd-composer-bar" data-testid="composer-bar">
      <div className="pd-composer-bar-left">
        <ProjectRegion />
      </div>
      {/* Empty flex spacer (round-15) — pushes the project chip left and the
          effort button right. The routed tier now lives on the footer chip. */}
      <div className="pd-composer-bar-center" />
      {/* Context-fullness ring sits to the LEFT of Effort (round-A #5). */}
      <div className="pd-composer-bar-right">
        <ContextRegion />
        <EffortRegion />
      </div>
    </div>
  );
}
