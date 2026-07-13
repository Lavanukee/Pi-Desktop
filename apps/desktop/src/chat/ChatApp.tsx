/**
 * The real chat app: a 3-region layout (session sidebar · top bar · thread +
 * composer) wired to pi. Spawns the pi session on mount, keeps pi's model list
 * fresh for the footer, and hosts the blocking-dialog + toast surfaces.
 *
 * Round-3: the sidebar slides in/out (its slot collapses so the surface reclaims
 * the space, #A6); the empty state centers the greeting + composer vertically
 * (#A3); the collapse control lives in the sidebar just right of the traffic
 * lights (#A5); files can be dropped anywhere in the window (#A8).
 */
import {
  type CanvasController,
  CanvasProvider,
  createCanvasController,
  IconPanelRight,
} from '@pi-desktop/canvas';
import type { Model } from '@pi-desktop/engine';
import { IconButton, IconClose, MainSurface, TopBar } from '@pi-desktop/ui';
import { useEffect, useRef, useState } from 'react';
import type { SettingsSection } from '../settings/SettingsView';
import { registerCanvasControllerReset, useCanvasStore } from '../state/canvas-store';
import { getModels, setSessionName, startPi } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { useProjectStore } from '../state/project-store';
import { applySavedHarnessConfig } from '../state/settings-store';
import { useThemeStore } from '../store/theme';
import { preloadFastestModel } from './auto-router';
import { ChatComposer } from './ChatComposer';
import { ChatThread } from './ChatThread';
import { ChatTitle } from './ChatTitle';
import { CanvasTabsPanel } from './canvas/CanvasTabsPanel';
import { useHarnessTitleSync } from './harness-title';
import { SessionSidebar, type SidebarStub } from './SessionSidebar';
import { ToastHost } from './ToastHost';
import { UiRequestDialogs } from './UiRequestDialogs';
import { WindowDropOverlay } from './WindowDropOverlay';

/**
 * Round-8 #11/#16: the chat top-right holds EXACTLY ONE control — the canvas
 * open/close toggle — and only while the canvas is CLOSED (panel icon → open).
 * Once the canvas is open, its own top-right carries the toggle (an X), so this
 * one hides: there is never a duplicate toggle and never a terminal icon here.
 * Rendered INSIDE `<CanvasProvider>` so it can reach the shared open state.
 */
function CanvasTopBarControls() {
  const canvasOpen = useCanvasStore((s) => s.canvasOpen);
  const toggleCanvasOpen = useCanvasStore((s) => s.toggleCanvasOpen);
  if (canvasOpen) return null;
  return (
    <IconButton
      aria-label="Open canvas"
      aria-pressed={false}
      data-testid="canvas-toggle"
      onClick={() => toggleCanvasOpen()}
    >
      <IconPanelRight />
    </IconButton>
  );
}

const STUB_COPY: Record<SidebarStub, { title: string; body: string }> = {
  projects: {
    title: 'Projects',
    body: 'Group chats, files, and context into projects. Coming soon.',
  },
  scheduled: {
    title: 'Scheduled tasks',
    body: 'Run Pi on a schedule and review the results. Coming soon.',
  },
  skills: { title: 'Skills', body: 'Browse and manage the skills Pi can use. Coming soon.' },
};

/** A lightweight "coming soon" overlay for nav destinations without a page yet. */
function StubPanel({ stub, onClose }: { stub: SidebarStub; onClose: () => void }) {
  const { title, body } = STUB_COPY[stub];
  return (
    <div className="pd-stub-overlay" data-testid="stub-panel">
      <div className="pd-stub-card">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-heading text-text-primary">{title}</h2>
          <IconButton aria-label="Close" onClick={onClose}>
            <IconClose size={14} />
          </IconButton>
        </div>
        <p className="text-body text-text-muted">{body}</p>
      </div>
    </div>
  );
}

export function ChatApp({
  onOpenSettings,
  onOpenConnectors,
}: {
  onOpenSettings: (section: SettingsSection) => void;
  onOpenConnectors: () => void;
}) {
  const messageCount = usePiStore((s) => s.messages.length);
  const windowTitle = usePiStore((s) => s.windowTitle);
  const modelId = usePiStore((s) => s.agent.model?.id ?? null);

  // Consume the harness's auto-generated conversation title → session title
  // (new chats get a real name; a user rename is never clobbered).
  useHarnessTitleSync();
  const flavor = useThemeStore((s) => s.flavor);
  const [piModels, setPiModels] = useState<Model[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [truncatedNote, setTruncatedNote] = useState(false);
  const [stub, setStub] = useState<SidebarStub | null>(null);

  // Load the persisted project (working folder) first, then spawn the window's
  // pi session rooted at it (so the initial session adopts the active project's
  // cwd, round-8 #15), then push any saved harness config (permission/effort),
  // then preload the FASTEST downloaded model so a model is ALWAYS resident with
  // the lowest TTFT (round-A #4; a no-op unless Auto + something downloaded + no
  // server yet). Preload runs last so it respawns pi onto the just-started session.
  useEffect(() => {
    void useProjectStore
      .getState()
      .load()
      .then(() => {
        const cwd = useProjectStore.getState().activePath ?? undefined;
        return startPi(cwd !== undefined ? { cwd } : {});
      })
      .then(() => applySavedHarnessConfig())
      .then(() => preloadFastestModel());
  }, []);

  // Tiny-window adaptation (adversarial finding): a narrow window lets the fixed
  // ~300px sidebar squeeze the chat and overflow the pane. Auto-collapse it below
  // this breakpoint (chosen above the window's 640px minWidth so it can actually
  // engage); the user can still reopen it manually once there's room.
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 720) setSidebarOpen(false);
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Keep pi's model list fresh for the footer picker (refetch when the active
  // model changes — e.g. after a local model is brought online + pi restarted).
  // biome-ignore lint/correctness/useExhaustiveDependencies: modelId is a re-fetch trigger, not read in the effect
  useEffect(() => {
    void getModels().then((res) => {
      if (res.success) setPiModels(res.models);
    });
  }, [modelId]);

  // App-owned canvas controller (the blessed CanvasProvider pattern — "the app
  // usually creates one and drives it"). Owning it here lets us register its
  // tab-reset with the session lifecycle so a new/switched conversation starts
  // with a clean canvas (session isolation, backlog #2).
  const canvasController = useRef<CanvasController | null>(null);
  if (canvasController.current === null) canvasController.current = createCanvasController();
  useEffect(() => {
    const controller = canvasController.current;
    if (controller === null) return;
    registerCanvasControllerReset(() => controller.reset());
    return () => registerCanvasControllerReset(null);
  }, []);

  const title = windowTitle ?? (messageCount > 0 ? 'Chat' : 'New chat');
  const empty = messageCount === 0;

  // ONE composer instance across the empty→thread transition: a stable `key` +
  // a stable DOM parent (the keyed composer slot below) keep React from
  // unmounting it, so focus survives the first send (adversarial finding).
  const composer = (
    <ChatComposer
      key="composer"
      piModels={piModels}
      onOpenModels={() => onOpenSettings('models')}
    />
  );

  return (
    <CanvasProvider controller={canvasController.current}>
      <div className="flex h-full">
        {/* The sidebar stays mounted; when collapsed the slot narrows to a
            ~64px ICON RAIL (round-8 #1) rather than hiding — global.css owns the
            rail width + the panel's stay-put override. */}
        <div className="pd-sidebar-slot" data-open={sidebarOpen}>
          <SessionSidebar
            open={sidebarOpen}
            onCollapse={() => setSidebarOpen(false)}
            onExpand={() => setSidebarOpen(true)}
            onTruncated={() => setTruncatedNote(true)}
            onOpenSettings={onOpenSettings}
            onOpenConnectors={onOpenConnectors}
            onOpenStub={setStub}
          />
        </div>

        <MainSurface className="flex min-w-0 flex-1 flex-col">
          <TopBar
            // The rail always hosts the traffic lights now, so the top bar never
            // needs to inset for them — EXCEPT when the sidebar is COLLAPSED to the
            // narrow rail: the macOS traffic lights overhang past that ~52px rail
            // into the top bar, so the class below insets the title clear of the
            // lights (+ the rail's expand control). Expanded, the wide sidebar
            // already clears them.
            trafficLightInset={false}
            className={sidebarOpen ? undefined : 'pd-topbar--sidebar-collapsed'}
            left={
              // The chat title sits just RIGHT of the sidebar/rail (#13). The
              // rail carries its own expand toggle, so no top-bar sidebar button.
              <ChatTitle title={title} onRename={(name) => void setSessionName(name)} />
            }
            right={
              // Round-8 #11/#16: the ONLY top-right control is the canvas toggle,
              // and only while the canvas is closed (it moves into the canvas when
              // open). No terminal icon, no duplicate.
              <CanvasTopBarControls />
            }
          />

          {/* One flex column that hosts BOTH states so the keyed composer slot
              below keeps the same DOM parent across empty→thread. #A3: the empty
              state centers the greeting + composer vertically. */}
          <div
            className={`flex min-h-0 flex-1 flex-col ${
              empty ? 'items-center justify-center gap-6 px-6' : ''
            }`}
          >
            {empty ? (
              <div key="lead" className="flex flex-col items-center gap-2">
                <h1 className="text-title">Pi Desktop</h1>
                <p className="text-body text-text-muted">
                  {flavor === 'claude' ? 'How can I help you today?' : 'What are we building?'}
                </p>
              </div>
            ) : (
              <div key="lead" className="flex min-h-0 flex-1 flex-col">
                <ChatThread />
              </div>
            )}
            <div key="composer-slot" className={empty ? 'w-full' : 'shrink-0 px-4 pb-4 pt-2'}>
              {!empty && truncatedNote ? (
                <div className="mx-auto mb-2 max-w-[700px] text-caption text-text-muted">
                  Restored an earlier session; some history was truncated.
                </div>
              ) : null}
              {/* Round-12 W2: the project (working-folder) chip moved OFF the
                  top of the composer into the sticking-out ComposerBar below the
                  input (mounted inside ChatComposer). */}
              {composer}
            </div>
          </div>

          {stub !== null ? <StubPanel stub={stub} onClose={() => setStub(null)} /> : null}
        </MainSurface>

        <CanvasTabsPanel />

        <UiRequestDialogs />
        <ToastHost />
        <WindowDropOverlay />
      </div>
    </CanvasProvider>
  );
}
