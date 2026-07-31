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
import { useMemo, useRef } from 'react';
import { assignChat, createProject, useChatOrg } from '../state/chat-org';
import { useCorpStore } from '../state/corp-store';
import { useLlmStore } from '../state/llm-store';
import { autoEffortForTier } from '../state/model-selection';
import { restartPi } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { useProjectStore } from '../state/project-store';
import { useEffortMode, useSettingsStore } from '../state/settings-store';
import {
  activeVisibleProjectId,
  autoProjectPath,
  useVisibleProjects,
} from '../state/visible-projects';
import {
  type ContextGaugeView,
  EFFORT_STEP_COUNT,
  effortSliderView,
  levelForIndex,
  resolveContextGauge,
  stickyContextGauge,
  usesSandbox,
} from './composer-bar-logic';
import { useHarnessStatus } from './harness-status';

/** LEFT: the relocated project (working-folder) chip, slimmed for the bar. When
 * the selected project folder is MISSING and pi fell back to the conversation
 * sandbox, the chip drops the stale name for a subtle "Sandbox" warn state
 * (jedd #13) instead of pretending the dead folder is the working dir. */
function ProjectRegion() {
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
  const sessionFile = usePiStore((s) => s.session?.sessionFile);
  const selectProjectPath = useProjectStore((s) => s.selectPath);
  const clearProject = useProjectStore((s) => s.clearProject);

  // When the viewed chat belongs to a sidebar chat-org project, the chip shows
  // that project's NAME (jedd: "just named their project name as far as the user
  // is concerned") — this is what turns the "Sandbox" placeholder into the project
  // name for a projectless project's shared-sandbox chats.
  const chatOrg = useChatOrg();
  // The sidebar's user-made projects (e.g. "mac") are ALSO selectable here, so
  // the picker lists everything the user thinks of as a project — not just the
  // electron working folders (jedd: "mac project doesn't show as selectable").
  const orgProjectId = useMemo(() => {
    if (sessionFile === undefined || sessionFile.length === 0) return null;
    const pid = chatOrg.assignments[sessionFile];
    return pid !== undefined && chatOrg.projects.some((p) => p.id === pid) ? pid : null;
  }, [chatOrg, sessionFile]);
  const orgProjectName =
    orgProjectId === null
      ? null
      : (chatOrg.projects.find((p) => p.id === orgProjectId)?.name ?? null);

  /*
   * EXACTLY WHAT THE SIDEBAR LISTS. This used to be the electron project store —
   * every working folder the app had ever been pointed at — unioned with the
   * sidebar's manual projects. After a day of probe runs that meant eight
   * throwaway `unify-*` directories in the dropdown, none of them in the sidebar.
   * jedd: "nothing should be in this dropdown if it isn't in the left sidebar."
   * One derivation now, shared, so the two cannot drift apart again.
   */
  const visible = useVisibleProjects();
  const items = useMemo(() => visible.map((p) => ({ id: p.id, name: p.name })), [visible]);
  /** An auto folder is selected by its PATH; a real project by its id. The path
   * is decoded by the list that encoded it, so only one module knows the shape. */
  const autoPathById = useMemo(() => {
    const out = new Map<string, string>();
    for (const p of visible) {
      const path = autoProjectPath(p);
      if (path !== null) out.set(p.id, path);
    }
    return out;
  }, [visible]);
  const orgIds = useMemo(() => new Set(chatOrg.projects.map((p) => p.id)), [chatOrg.projects]);

  /** Create a sidebar project by name and put this chat in it. */
  const createNamedProject = async (name: string) => {
    const id = await createProject(name);
    if (sessionFile !== undefined && sessionFile.length > 0) {
      await assignChat(sessionFile, id);
    }
  };

  /** Selecting a FOLDER makes it this chat's project too. The rows are radios, so
   * a manual assignment left behind would keep ITS check mark and the click would
   * again look ignored; dropping it also lets the chat's sidebar row follow the
   * folder it now lives in. */
  const selectAutoFolder = async (path: string) => {
    if (orgProjectId !== null && sessionFile !== undefined && sessionFile.length > 0) {
      await assignChat(sessionFile, null);
    }
    await selectProjectPath(path);
  };

  // Selecting a sidebar project = put THIS chat in it (assign + root at its
  // folder / shared sandbox) — the same "this chat's project" meaning the chip
  // already has for working folders.
  const selectOrgProject = async (id: string) => {
    const project = chatOrg.projects.find((p) => p.id === id);
    if (project === undefined) return;
    if (sessionFile !== undefined && sessionFile.length > 0) {
      await assignChat(sessionFile, project.id);
    }
    let cwd = project.cwd;
    if (cwd === undefined || cwd.length === 0) {
      const res = await window.piDesktop
        .invoke('project:project-sandbox', { id: project.id })
        .catch(() => null);
      cwd = res?.path ?? undefined;
    }
    if (typeof cwd === 'string' && cwd.length > 0) {
      await restartPi({
        cwd,
        ...(sessionFile !== undefined && sessionFile.length > 0
          ? { sessionPath: sessionFile }
          : {}),
      });
    }
    if (project.cwd !== undefined && project.cwd.length > 0) {
      await window.piDesktop.invoke('project:set', { path: project.cwd }).catch(() => null);
      await useProjectStore
        .getState()
        .load()
        .catch(() => {});
    }
  };

  const sandbox = usesSandbox(activePath, sessionCwd, sandboxFlag ?? projectMissing);
  const className = [
    'pd-project-picker--bar',
    sandbox && orgProjectName === null ? 'pd-project-picker--sandbox' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <ProjectPicker
      className={className}
      projects={items}
      // The active entry is the chat's org project (if it's in one), else the
      // selected working folder (unless pi fell back to the sandbox) — resolved
      // against the LIST's ids, not the electron project store's, which is a
      // different id space that no row could ever match (activeVisibleProjectId).
      active={activeVisibleProjectId(visible, {
        orgProjectId,
        workingPath: sandbox ? null : activePath,
      })}
      // The list holds exactly two kinds of id: a directory-derived folder,
      // selected by its PATH, and a project the user made, selected by its id.
      onSelect={(id) => {
        const autoPath = autoPathById.get(id);
        if (autoPath !== undefined) void selectAutoFolder(autoPath);
        else if (orgIds.has(id)) void selectOrgProject(id);
      }}
      /* A NAMED project, in both places at once. This used to call the electron
         `project:new` folder picker, which registered a working directory that the
         sidebar never listed — the source of the clutter jedd found. Creating a
         real chat-org project puts it in `org.projects`, which IS the sidebar's
         list and now the picker's, and assigns this chat to it. */
      onNew={(name) => {
        if (name === undefined || name.trim().length === 0) return;
        void createNamedProject(name.trim());
      }}
      onClear={() => void clearProject()}
      /* "Sandbox" and "No project" were two labels for one state — a chat with
         no working folder, whose files go to its own private folder. jedd: call
         it "No project". The distinction only ever mattered internally. */
      placeholder={orgProjectName ?? 'No project'}
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
  // While the local server is loading the model, show a "Loading model…" label
  // right here (left of Effort, by the selector) so the input bar reflects that
  // the model is warming up (jedd) — it takes over from the context ring, which
  // has nothing to show pre-first-turn anyway.
  const serverLoading = useLlmStore((s) => s.status.phase === 'starting');
  const harnessPercent = useHarnessStatus()?.contextPercent;
  // During a corp run, pi's own harness sits idle — the ring fills from the
  // RUN's real context usage instead (threaded off the live worker transcript).
  const corpTaskId = useCorpStore((s) => s.taskId);
  const corpPercent = useCorpStore((s) => s.contextPercent);
  const contextPercent = corpTaskId !== null && corpPercent !== null ? corpPercent : harnessPercent;
  const fresh = resolveContextGauge({ contextPercent, messages, contextWindow });

  // Hold the last non-null value across a momentary null so the ring renders
  // reliably during a turn and doesn't flicker to empty — a model swap zeroes the
  // launched window for a frame, and the harness status can be briefly cleared
  // between turns. Reset when the THREAD identity changes (new / switched session,
  // keyed on the first message id — empty on a brand-new chat) so a fresh
  // conversation starts empty instead of inheriting the previous thread's fill.
  const threadKey = messages.length === 0 ? '' : (messages[0]?.id ?? '');
  const stickyRef = useRef<{ key: string; gauge: ContextGaugeView | null }>({
    key: threadKey,
    gauge: null,
  });
  if (stickyRef.current.key !== threadKey) stickyRef.current = { key: threadKey, gauge: null };
  const gauge = stickyContextGauge(fresh, stickyRef.current.gauge);
  stickyRef.current.gauge = gauge;

  if (serverLoading) {
    return (
      <span className="pd-composer-model-loading" data-testid="composer-model-loading">
        <span className="pd-working-label">Loading model…</span>
      </span>
    );
  }
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
