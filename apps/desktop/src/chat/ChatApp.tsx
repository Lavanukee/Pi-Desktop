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
import { CanvasProvider } from '@pi-desktop/canvas';
import type { Model } from '@pi-desktop/engine';
import { IconButton, IconClose, IconSidebar, MainSurface, TopBar } from '@pi-desktop/ui';
import { useEffect, useState } from 'react';
import { IconMoon, IconSun } from '../settings/icons';
import type { SettingsSection } from '../settings/SettingsView';
import { getModels, setSessionName, startPi } from '../state/pi-connect';
import { usePiStore } from '../state/pi-slice';
import { applySavedHarnessConfig, useSettingsStore } from '../state/settings-store';
import { useThemeStore } from '../store/theme';
import { ChatComposer } from './ChatComposer';
import { ChatThread } from './ChatThread';
import { ChatTitle } from './ChatTitle';
import { CanvasTabsPanel } from './canvas/CanvasTabsPanel';
import { SessionSidebar, type SidebarStub } from './SessionSidebar';
import { ToastHost } from './ToastHost';
import { UiRequestDialogs } from './UiRequestDialogs';
import { WindowDropOverlay } from './WindowDropOverlay';

/**
 * Light/dark quick toggle glyph (round-5 #15): a sun (shown in dark mode) and a
 * moon (shown in light mode) stacked, cross-fading + rotating between the two on
 * click. Reduced-motion drops the transition (CSS). The icon reads as "the sun"
 * in the app's default dark mode, morphing on the flip.
 */
function ThemeToggleIcon({ mode }: { mode: 'dark' | 'light' }) {
  return (
    <span className="pd-theme-toggle" data-mode={mode} aria-hidden>
      <IconSun className="pd-theme-toggle-sun" />
      <IconMoon className="pd-theme-toggle-moon" />
    </span>
  );
}

const STUB_COPY: Record<SidebarStub, { title: string; body: string }> = {
  projects: {
    title: 'Projects',
    body: 'Group chats, files, and context into projects. Coming soon.',
  },
  artifacts: {
    title: 'Artifacts',
    body: 'A gallery of everything Pi has made for you. Coming soon.',
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
}: {
  onOpenSettings: (section: SettingsSection) => void;
}) {
  const messageCount = usePiStore((s) => s.messages.length);
  const windowTitle = usePiStore((s) => s.windowTitle);
  const modelId = usePiStore((s) => s.agent.model?.id ?? null);
  const flavor = useThemeStore((s) => s.flavor);
  const mode = useThemeStore((s) => s.mode);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const [piModels, setPiModels] = useState<Model[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [truncatedNote, setTruncatedNote] = useState(false);
  const [stub, setStub] = useState<SidebarStub | null>(null);

  // Spawn the window's pi session once, then push any saved harness config
  // (permission/effort) that differs from the harness defaults.
  useEffect(() => {
    void startPi({}).then(() => applySavedHarnessConfig());
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
    <CanvasProvider>
      <div className="flex h-full">
        {/* The sidebar stays mounted so it can slide; the slot collapses its
            width when closed (the panel itself translates off-screen). */}
        <div className="pd-sidebar-slot" data-open={sidebarOpen}>
          <SessionSidebar
            open={sidebarOpen}
            onCollapse={() => setSidebarOpen(false)}
            onTruncated={() => setTruncatedNote(true)}
            onOpenSettings={onOpenSettings}
            onOpenStub={setStub}
          />
        </div>

        <MainSurface className="flex min-w-0 flex-1 flex-col">
          <TopBar
            trafficLightInset={!sidebarOpen}
            left={
              // The chat title sits just RIGHT of the sidebar (#13), not centered.
              // With the sidebar open its own collapse control (#A5) is used; the
              // top-bar toggle only appears to re-open a collapsed sidebar.
              <>
                {sidebarOpen ? null : (
                  <IconButton aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}>
                    <IconSidebar />
                  </IconButton>
                )}
                <ChatTitle title={title} onRename={(name) => void setSessionName(name)} />
              </>
            }
            right={
              // Cleaned up (round-5): only the animated light/dark quick toggle
              // remains. The confusing message-bubble icon (#14) and the dev
              // gallery toggle (#23 → moved into settings) are both gone; flavor +
              // full theme control live in the settings menu. The control is a
              // .pd-btn IconButton, which opts out of the top bar's drag region.
              <IconButton
                aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                data-testid="toggle-mode"
                onClick={() => void setTheme({ mode: mode === 'dark' ? 'light' : 'dark' })}
              >
                <ThemeToggleIcon mode={mode} />
              </IconButton>
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
