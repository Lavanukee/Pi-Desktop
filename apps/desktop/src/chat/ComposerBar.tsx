/**
 * ComposerBar (round-12 W2, jedd #6) — the thin "sticking-out" bar fused to the
 * bottom edge of the input card and protruding below it. Three regions:
 *   LEFT   — the active-folder (project) button, relocated here from above the
 *            composer and slimmed (reuses the canvas ProjectPicker verbatim).
 *   CENTER — the active model tier (Fast/Balanced/Intelligent, from the harness
 *            `activeTier`); hover reveals "request categorized as <class>".
 *   RIGHT  — the effort SLIDER (blue fill-pill): Auto · <tier> by default, or an
 *            explicit level once dragged (max only reachable by an explicit drag).
 *
 * Reads harness status (`useHarnessStatus`), the project store, and settings;
 * writes effort through the existing settings-store `update` (which persists +
 * pushes `/harness effort`). Imports the tier/effort mapping — it does not
 * redefine it (state/model-selection + composer-bar-logic own that).
 */
import { ProjectPicker } from '@pi-desktop/canvas';
import { EffortSlider, Tooltip } from '@pi-desktop/ui';
import { autoEffortForTier } from '../state/model-selection';
import { useProjectStore } from '../state/project-store';
import { useEffortMode, useSettingsStore } from '../state/settings-store';
import {
  classificationHover,
  EFFORT_STEP_COUNT,
  effortSliderView,
  levelForIndex,
  tierLabel,
} from './composer-bar-logic';
import { useHarnessStatus } from './harness-status';

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

/** CENTER: the active model tier + the classification hover. */
function TierRegion() {
  const status = useHarnessStatus();
  const activeTier = status?.activeTier ?? null;
  const label = tierLabel(activeTier);

  if (label === null) {
    return (
      <Tooltip side="top" label="Model tier is chosen automatically each turn">
        <span className="pd-tier pd-tier--auto" data-testid="composer-tier">
          <span className="pd-tier-dot" aria-hidden="true" />
          Auto
        </span>
      </Tooltip>
    );
  }
  const hover = classificationHover(status?.activeClass ?? null) ?? 'Active model tier';
  return (
    <Tooltip side="top" label={hover}>
      <span className="pd-tier" data-tier={activeTier} data-testid="composer-tier">
        <span className="pd-tier-dot" data-tier={activeTier} aria-hidden="true" />
        {label}
      </span>
    </Tooltip>
  );
}

/** RIGHT: the effort slider (Auto · tier / explicit level). */
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
    <EffortSlider
      steps={EFFORT_STEP_COUNT}
      value={view.index}
      fill={view.fill}
      auto={view.auto}
      label={view.label}
      valueText={view.valueText}
      onLevelChange={onLevelChange}
      onAuto={onAuto}
      data-testid="composer-effort"
    />
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
