/**
 * ComposerBar (round-12 W2, jedd #6) — the thin "sticking-out" bar fused to the
 * bottom edge of the input card and protruding below it. Three regions:
 *   LEFT   — the active-folder (project) button, relocated here from above the
 *            composer and slimmed (reuses the canvas ProjectPicker verbatim).
 *   CENTER — under Auto routing, the clickable "[Auto] · [<tier>]" control (both
 *            halves open the shared tier picker); hover reveals "request
 *            categorized as <class>". Hidden when a tier/model is pinned — the
 *            footer chip names it then (round-14 #3).
 *   RIGHT  — the "Effort" button; the effort SLIDER (blue→hot temperature pill)
 *            opens in a popover (round-14 #2). Auto · <level> by default, or an
 *            explicit level once dragged (max only reachable by an explicit drag).
 *
 * Reads harness status (`useHarnessStatus`), the project store, and settings;
 * writes effort through the existing settings-store `update` (which persists +
 * pushes `/harness effort`). Imports the tier/effort mapping — it does not
 * redefine it (state/model-selection + composer-bar-logic own that).
 */
import { ProjectPicker } from '@pi-desktop/canvas';
import {
  EffortSlider,
  IconGauge,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from '@pi-desktop/ui';
import { autoEffortForTier } from '../state/model-selection';
import { useProjectStore } from '../state/project-store';
import { useEffortMode, useModelSelection, useSettingsStore } from '../state/settings-store';
import {
  classificationHover,
  EFFORT_STEP_COUNT,
  effortSliderView,
  levelForIndex,
  tierLabel,
} from './composer-bar-logic';
import { useHarnessStatus } from './harness-status';
import { TierPickerMenu } from './TierPickerMenu';

/** LEFT: the relocated project (working-folder) chip, slimmed for the bar. */
function ProjectRegion() {
  const projects = useProjectStore((s) => s.projects);
  const activeId = useProjectStore((s) => s.activeId);
  const selectProject = useProjectStore((s) => s.selectProject);
  const newProject = useProjectStore((s) => s.newProject);
  const clearProject = useProjectStore((s) => s.clearProject);
  return (
    <ProjectPicker
      className="pd-project-picker--bar"
      projects={projects.map((p) => ({ id: p.id, name: p.name }))}
      active={activeId}
      onSelect={(id) => void selectProject(id)}
      onNew={() => void newProject()}
      onClear={() => void clearProject()}
      placeholder="No project"
    />
  );
}

/** CENTER: under Auto, the clickable "[Auto] · [<tier>]" control; both halves
 * open the shared tier picker. Hidden when a tier/model is pinned (the footer
 * chip names it). No decorative dot — the "·" is a plain text separator. */
function TierRegion() {
  const status = useHarnessStatus();
  const activeTier = status?.activeTier ?? null;
  const isAuto = useModelSelection().mode === 'auto';

  // A pinned tier/model is named by the footer model chip (issue 4); the center
  // only speaks for Auto routing, so render nothing otherwise.
  if (!isAuto) return null;

  const tier = tierLabel(activeTier);
  const hover =
    classificationHover(status?.activeClass ?? null) ??
    'Model tier is chosen automatically each turn';

  return (
    <Tooltip side="top" label={hover}>
      <span className="pd-tier pd-tier--auto" data-testid="composer-tier">
        <TierPickerMenu side="top" align="start">
          <button type="button" className="pd-tier-seg" data-testid="composer-tier-auto">
            Auto
          </button>
        </TierPickerMenu>
        {tier !== null ? (
          <>
            <span className="pd-tier-sep" aria-hidden="true">
              ·
            </span>
            <TierPickerMenu side="top" align="start">
              <button type="button" className="pd-tier-seg" data-testid="composer-tier-value">
                {tier}
              </button>
            </TierPickerMenu>
          </>
        ) : null}
      </span>
    </Tooltip>
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
      <div className="pd-composer-bar-center">
        <TierRegion />
      </div>
      <div className="pd-composer-bar-right">
        <EffortRegion />
      </div>
    </div>
  );
}
