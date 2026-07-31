import { Spinner, ToastProvider, TooltipProvider } from '@pi-desktop/ui';
import { lazy, Suspense, useEffect, useState } from 'react';
import type { AppInfo } from '../electron/ipc-contract';
import { ChatApp } from './chat/ChatApp';
import { CanvasPopoutView } from './chat/canvas/CanvasPopoutView';
import { ConnectorsScreen } from './connectors/ConnectorsScreen';
import { SituationDemoView } from './demo/SituationDemoView';
import { GalleryView } from './gallery/GalleryView';
import { FirstRunTips, resetFirstRunTips } from './onboarding/FirstRunTips';
import { OnboardingWizard } from './onboarding/OnboardingWizard';
import { type SettingsSection, SettingsView } from './settings/SettingsView';
import { useModalityStore } from './state/modality-store';
import { applyThemeAttributes, useThemeStore } from './store/theme';

/** First-run gate status: unknown until onboarding:get-state resolves. */
type GateStatus = 'loading' | 'onboarding' | 'ready';

/** The standalone canvas pop-out window loads with `?canvasPopout=1`. */
const IS_CANVAS_POPOUT = new URLSearchParams(window.location.search).has('canvasPopout');

/** Dev/demo route: the situation room driven by the scripted mock corp run. */
const IS_SITUATION_DEMO = new URLSearchParams(window.location.search).has('situationDemo');

/** UI-only preview route: the Tripo-style 3D workspace (`?tripo=1`, dev
 * override PI_DESKTOP_TRIPO=1). Lazy so the workspace stays out of the main
 * bundle for every normal launch. */
const IS_TRIPO = new URLSearchParams(window.location.search).has('tripo');
const TripoWorkspace = lazy(() =>
  import('./tripo/TripoWorkspace').then((m) => ({ default: m.TripoWorkspace })),
);

/**
 * Hidden probe hooks: keep the boot-event / theme / app-info testids the
 * built-app E2E probes assert on (tests/e2e/probe.mjs, packaged-probe.mjs)
 * without cluttering the real UI. sr-only, not display:none, so Playwright can
 * still read their text.
 */
function ProbeHooks() {
  const flavor = useThemeStore((s) => s.flavor);
  const mode = useThemeStore((s) => s.mode);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    void window.piDesktop.invoke('app:get-info', undefined).then(setInfo);
    return window.piDesktop.onEvent('app:boot', () => setBooted(true));
  }, []);

  return (
    <div className="sr-only" aria-hidden>
      <span data-testid="theme-chip">
        {flavor} / {mode}
      </span>
      <span data-testid="boot-state">
        {booted ? 'boot event received' : 'waiting for boot event…'}
      </span>
      {info !== null ? (
        <span data-testid="app-info">
          Electron {info.electronVersion} · Chrome {info.chromeVersion} · Node {info.nodeVersion}
        </span>
      ) : null}
    </div>
  );
}

type MainView = 'chat' | 'gallery' | 'settings' | 'connectors';

export function App() {
  const flavor = useThemeStore((s) => s.flavor);
  const mode = useThemeStore((s) => s.mode);
  const modalityView = useModalityStore((s) => s.view);
  const [view, setView] = useState<MainView>('chat');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('models');
  const [gate, setGate] = useState<GateStatus>('loading');

  useEffect(() => {
    applyThemeAttributes(document.documentElement, { flavor, mode });
  }, [flavor, mode]);

  /*
   * WARM THE MODEL WHILE THE USER IS STILL READING THE SCREEN.
   *
   * The chat server was started lazily by the first SEND, so the first message
   * of every session paid for the whole cold start inside the user's turn.
   * Measured from the keypress: 12,986ms / 15,257ms / 17,292ms before a single
   * character appeared. Nothing explained the wait, so it reads as a hang.
   *
   * None of that work depends on what the user types. Starting it at mount moves
   * it into the seconds someone spends looking at an empty chat and deciding
   * what to ask, and `ensureChatServerReady` is idempotent + already guarded by
   * an in-flight promise, so the send simply finds it done.
   *
   * Deliberately not gated on onboarding finishing: a profile with no model
   * resolves to nothing and returns immediately.
   */
  useEffect(() => {
    if (IS_CANVAS_POPOUT || IS_SITUATION_DEMO || IS_TRIPO) return;
    void import('./chat/auto-router')
      .then(({ ensureChatServerReady }) => ensureChatServerReady())
      .catch(() => undefined);
  }, []);

  // "Redo onboarding" (Settings → Interface): clear the persisted first-run flag,
  // re-arm the first-run tips, and re-open the wizard. Settings persist; the
  // wizard applies fresh choices live.
  const redoOnboarding = () => {
    void window.piDesktop.invoke('onboarding:reset', undefined).catch(() => undefined);
    resetFirstRunTips();
    setView('chat');
    setGate('onboarding');
  };

  // First-run gate: onboarding runs before ChatApp until the choices are
  // persisted. The boot theme is owned solely by settings.json (applied by
  // connectSettings, and seeded from onboarding.json on first read) — applying
  // the onboarding choices here too would race that and clobber a theme the user
  // has since changed via the top-bar toggle / settings panel (which write
  // settings.json, not onboarding.json). The canvas pop-out never onboards.
  useEffect(() => {
    if (IS_CANVAS_POPOUT || IS_SITUATION_DEMO || IS_TRIPO) return;
    let cancelled = false;
    window.piDesktop
      .invoke('onboarding:get-state', undefined)
      .then((state) => {
        if (cancelled) return;
        setGate(state.firstRunComplete ? 'ready' : 'onboarding');
      })
      .catch(() => {
        // If the gate can't be read, fall through to onboarding rather than
        // stranding the user on a blank screen.
        if (!cancelled) setGate('onboarding');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The 3D Studio modality: reached from the sidebar "Modalities" dropdown (or
  // the ?tripo=1 dev route). A full-window takeover with its own back-to-chat
  // button; when active it replaces the chat shell entirely.
  if (IS_TRIPO || modalityView === '3d') {
    return (
      <TooltipProvider delayDuration={200}>
        <Suspense fallback={null}>
          <TripoWorkspace />
        </Suspense>
      </TooltipProvider>
    );
  }

  if (IS_CANVAS_POPOUT) {
    return (
      <TooltipProvider delayDuration={200}>
        <div className="h-full">
          <CanvasPopoutView />
        </div>
      </TooltipProvider>
    );
  }

  if (IS_SITUATION_DEMO) {
    return (
      <TooltipProvider delayDuration={200}>
        <div className="h-full">
          <SituationDemoView />
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <ToastProvider swipeDirection="right">
        <div className="h-full">
          {gate === 'loading' ? (
            <div className="flex h-full items-center justify-center text-accent-primary">
              <Spinner size={22} />
            </div>
          ) : gate === 'onboarding' ? (
            <OnboardingWizard onComplete={() => setGate('ready')} />
          ) : view === 'settings' ? (
            <SettingsView
              section={settingsSection}
              onSection={setSettingsSection}
              onClose={() => setView('chat')}
              onOpenGallery={() => setView('gallery')}
              onOpenConnectors={() => setView('connectors')}
              onRedoOnboarding={redoOnboarding}
            />
          ) : view === 'connectors' ? (
            <ConnectorsScreen onClose={() => setView('chat')} />
          ) : view === 'gallery' ? (
            <div className="flex h-full flex-col">
              {/* Left inset clears the macOS traffic lights (titleBarStyle:
                  hiddenInset ≈ 78px); the bar stays draggable, the button opts out. */}
              <div className="flex h-10 shrink-0 items-center gap-2 py-0 pr-3 pl-[80px] [-webkit-app-region:drag]">
                <button
                  type="button"
                  className="[-webkit-app-region:no-drag] text-footnote text-text-link"
                  onClick={() => setView('settings')}
                >
                  ← Back to settings
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <GalleryView />
              </div>
            </div>
          ) : (
            <div className="relative h-full">
              <ChatApp
                onOpenSettings={(section) => {
                  setSettingsSection(section);
                  setView('settings');
                }}
                onOpenConnectors={() => setView('connectors')}
              />
              {/* Onboarding `tutorial` flag consumer: dismissible first-run tips. */}
              <FirstRunTips />
            </div>
          )}
        </div>
        <ProbeHooks />
      </ToastProvider>
    </TooltipProvider>
  );
}
