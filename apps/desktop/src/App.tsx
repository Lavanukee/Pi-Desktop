import { Spinner, ToastProvider, TooltipProvider } from '@pi-desktop/ui';
import { useEffect, useState } from 'react';
import type { AppInfo } from '../electron/ipc-contract';
import { ChatApp } from './chat/ChatApp';
import { CanvasPopoutView } from './chat/canvas/CanvasPopoutView';
import { ConnectorsScreen } from './connectors/ConnectorsScreen';
import { GalleryView } from './gallery/GalleryView';
import { OnboardingWizard } from './onboarding/OnboardingWizard';
import { type SettingsSection, SettingsView } from './settings/SettingsView';
import { applyThemeAttributes, useThemeStore } from './store/theme';

/** First-run gate status: unknown until onboarding:get-state resolves. */
type GateStatus = 'loading' | 'onboarding' | 'ready';

/** The standalone canvas pop-out window loads with `?canvasPopout=1`. */
const IS_CANVAS_POPOUT = new URLSearchParams(window.location.search).has('canvasPopout');

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
  const [view, setView] = useState<MainView>('chat');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('models');
  const [gate, setGate] = useState<GateStatus>('loading');

  useEffect(() => {
    applyThemeAttributes(document.documentElement, { flavor, mode });
  }, [flavor, mode]);

  // First-run gate: onboarding runs before ChatApp until the choices are
  // persisted. The boot theme is owned solely by settings.json (applied by
  // connectSettings, and seeded from onboarding.json on first read) — applying
  // the onboarding choices here too would race that and clobber a theme the user
  // has since changed via the top-bar toggle / settings panel (which write
  // settings.json, not onboarding.json). The canvas pop-out never onboards.
  useEffect(() => {
    if (IS_CANVAS_POPOUT) return;
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

  if (IS_CANVAS_POPOUT) {
    return (
      <TooltipProvider delayDuration={200}>
        <div className="h-full">
          <CanvasPopoutView />
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <ToastProvider swipeDirection="right">
        <div className="h-full">
          {gate === 'loading' ? (
            <div className="flex h-full items-center justify-center">
              <Spinner size={18} />
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
            <ChatApp
              onOpenSettings={(section) => {
                setSettingsSection(section);
                setView('settings');
              }}
              onOpenConnectors={() => setView('connectors')}
            />
          )}
        </div>
        <ProbeHooks />
      </ToastProvider>
    </TooltipProvider>
  );
}
